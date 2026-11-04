//! Windows-only ownership boundary for the reserved daemon and worker pipe names.
//! No protocol byte is read or written until the connected server is verified.

use std::ffi::c_void;
use std::io;
use std::mem::size_of;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::ptr;

use tokio::net::windows::named_pipe::{NamedPipeClient, NamedPipeServer, ServerOptions};
use windows_sys::Win32::Foundation::{LocalFree, HANDLE};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo,
    SDDL_REVISION_1, SE_FILE_OBJECT,
};
#[cfg(test)]
use windows_sys::Win32::Security::{CreateWellKnownSid, WinWorldSid};
use windows_sys::Win32::Security::{
    EqualSid, GetTokenInformation, IsWellKnownSid, TokenUser, WinBuiltinAdministratorsSid,
    OWNER_SECURITY_INFORMATION, PSID, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::System::Pipes::GetNamedPipeServerProcessId;
use windows_sys::Win32::System::SystemInformation::{
    ComputerNameDnsFullyQualified, ComputerNameNetBIOS, GetComputerNameExW,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
};

const DAEMON_NAME: &str = "prime-agent-daemon";
const WORKER_NAME_PREFIX: &str = "prime-agent-worker-";

#[cfg(test)]
thread_local! {
    static TEST_DNS_HOSTNAME: std::cell::Cell<Option<&'static str>> = const { std::cell::Cell::new(None) };
}

#[cfg(test)]
thread_local! {
    // Native tests substitute the kernel-reported owner SID, then exercise
    // the real comparison and denial path without another Windows account.
    static TEST_FOREIGN_OWNER: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(test)]
pub(super) fn set_test_foreign_owner(value: bool) {
    TEST_FOREIGN_OWNER.with(|flag| flag.set(value));
}

fn local_computer_name_matches(host: &str) -> bool {
    [ComputerNameNetBIOS, ComputerNameDnsFullyQualified]
        .into_iter()
        .any(|format| {
            #[cfg(test)]
            if format == windows_sys::Win32::System::SystemInformation::ComputerNameDnsHostname {
                if let Some(name) = TEST_DNS_HOSTNAME.with(std::cell::Cell::get) {
                    return host.eq_ignore_ascii_case(name);
                }
            }
            let mut name = [0u16; 256];
            let mut length = u32::try_from(name.len()).expect("computer name buffer fits DWORD");
            // SAFETY: `name` is writable, and `length` describes its capacity.
            if unsafe { GetComputerNameExW(format, name.as_mut_ptr(), &raw mut length) } == 0 {
                return false;
            }
            usize::try_from(length)
                .ok()
                .and_then(|len| String::from_utf16(name.get(..len)?).ok())
                .is_some_and(|local| host.eq_ignore_ascii_case(&local))
        })
}

fn local_pipe_tail(name: &str) -> Option<&str> {
    let rest = name.strip_prefix(r"\\")?;
    let (host, path) = rest.split_once(['\\', '/'])?;
    let (namespace, tail) = path.split_once(['\\', '/'])?;
    if !namespace.eq_ignore_ascii_case("pipe") {
        return None;
    }
    if host == "."
        || host == "?"
        || host.eq_ignore_ascii_case("localhost")
        || host == "127.0.0.1"
        || host == "[::1]"
        || local_computer_name_matches(host)
    {
        Some(tail)
    } else {
        None
    }
}

pub(super) fn is_built_in_name(name: &str) -> bool {
    let Some(name) = local_pipe_tail(name) else {
        return false;
    };
    if name.eq_ignore_ascii_case(DAEMON_NAME) {
        return true;
    }
    let Some(prefix) = name.get(..WORKER_NAME_PREFIX.len()) else {
        return false;
    };
    if !prefix.eq_ignore_ascii_case(WORKER_NAME_PREFIX) {
        return false;
    }
    let remainder = &name[WORKER_NAME_PREFIX.len()..];
    let Some((key, worker)) = remainder.split_once('-') else {
        return false;
    };
    key.len() == 12
        && key.bytes().all(|byte| byte.is_ascii_hexdigit())
        && !worker.is_empty()
        && worker.len() <= 12
        && !worker.contains(['\\', '/'])
}

struct LocalAllocation(*mut c_void);

impl Drop for LocalAllocation {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: Windows allocated this value with LocalAlloc through a security API.
            unsafe { LocalFree(self.0) };
        }
    }
}

struct TokenUserBuffer(Vec<usize>);

impl TokenUserBuffer {
    fn from_process(process: HANDLE) -> io::Result<Self> {
        let mut raw_token = ptr::null_mut();
        // SAFETY: `process` is a live process handle and `raw_token` is writable.
        if unsafe { OpenProcessToken(process, TOKEN_QUERY, &raw mut raw_token) } == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: OpenProcessToken returned a new owned handle.
        let token = unsafe { OwnedHandle::from_raw_handle(raw_token) };
        let mut length = 0;
        // SAFETY: This first call asks Windows for the buffer length.
        unsafe {
            GetTokenInformation(
                token.as_raw_handle(),
                TokenUser,
                ptr::null_mut(),
                0,
                &raw mut length,
            )
        };
        if usize::try_from(length)
            .ok()
            .is_none_or(|len| len < size_of::<TOKEN_USER>())
            || length > 64 * 1024
        {
            return Err(io::Error::other("invalid Windows token user length"));
        }
        let words = (length as usize).div_ceil(size_of::<usize>());
        let mut buffer = vec![0_usize; words];
        // SAFETY: `buffer` is aligned for TOKEN_USER and has at least `length` bytes.
        if unsafe {
            GetTokenInformation(
                token.as_raw_handle(),
                TokenUser,
                buffer.as_mut_ptr().cast(),
                length,
                &raw mut length,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(buffer))
    }

    fn sid(&self) -> PSID {
        // SAFETY: GetTokenInformation wrote TOKEN_USER at the start of this aligned buffer.
        unsafe { (*self.0.as_ptr().cast::<TOKEN_USER>()).User.Sid }
    }
}

fn current_user() -> io::Result<TokenUserBuffer> {
    // SAFETY: GetCurrentProcess returns a pseudo-handle for this process.
    TokenUserBuffer::from_process(unsafe { GetCurrentProcess() })
}

fn server_process_user_matches(pipe: HANDLE, current_sid: PSID) -> io::Result<bool> {
    let mut pid = 0;
    // SAFETY: `pipe` is an open client pipe handle and `pid` is writable.
    if unsafe { GetNamedPipeServerProcessId(pipe, &raw mut pid) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: The requested access is limited to querying the process token.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: OpenProcess returned a new owned handle.
    let process = unsafe { OwnedHandle::from_raw_handle(process) };
    let server_user = TokenUserBuffer::from_process(process.as_raw_handle())?;
    // SAFETY: Both SID pointers remain live through their backing buffers.
    Ok(unsafe { EqualSid(server_user.sid(), current_sid) } != 0)
}

pub(super) fn verify_server_user(client: &NamedPipeClient) -> io::Result<()> {
    let current = current_user()?;
    let pipe = client.as_raw_handle();
    let mut owner_sid = ptr::null_mut();
    let mut raw_descriptor = ptr::null_mut();
    // SAFETY: `pipe` is open and the owner/descriptor output slots are writable.
    let status = unsafe {
        GetSecurityInfo(
            pipe,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &raw mut owner_sid,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            &raw mut raw_descriptor,
        )
    };
    let _descriptor = LocalAllocation(raw_descriptor);
    if status != 0 {
        return Err(io::Error::from_raw_os_error(status.cast_signed()));
    }
    if owner_sid.is_null() {
        return Err(io::Error::other("named pipe has no owner SID"));
    }
    #[cfg(test)]
    let mut foreign_sid = [0usize; 17];
    #[cfg(test)]
    if TEST_FOREIGN_OWNER.with(std::cell::Cell::get) {
        let mut length = u32::try_from(size_of::<[usize; 17]>()).expect("SID buffer fits DWORD");
        // SAFETY: The buffer is aligned and writable; the well-known World SID
        // stands in for a foreign owner after the real pipe descriptor is read.
        if unsafe {
            CreateWellKnownSid(
                WinWorldSid,
                ptr::null_mut(),
                foreign_sid.as_mut_ptr().cast(),
                &raw mut length,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        owner_sid = foreign_sid.as_mut_ptr().cast();
    }
    // SAFETY: The owner SID is part of the live descriptor and current.sid() is live.
    if unsafe { EqualSid(owner_sid, current.sid()) } != 0 {
        return Ok(());
    }
    // Older elevated same-user daemons can have Administrators as their default
    // pipe owner. Accept those only when the actual server process token is the
    // current user; every other foreign owner fails closed.
    // SAFETY: `owner_sid` remains live while `_descriptor` is in scope.
    if unsafe { IsWellKnownSid(owner_sid, WinBuiltinAdministratorsSid) } != 0
        && server_process_user_matches(pipe, current.sid())?
    {
        return Ok(());
    }
    Err(io::ErrorKind::PermissionDenied.into())
}

fn current_user_sddl() -> io::Result<Vec<u16>> {
    let current = current_user()?;
    let mut raw_string = ptr::null_mut();
    // SAFETY: The SID remains live and `raw_string` is writable.
    if unsafe { ConvertSidToStringSidW(current.sid(), &raw mut raw_string) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let _string = LocalAllocation(raw_string.cast());
    let length = (0..256)
        .find(|&index| {
            // SAFETY: Windows returns a NUL-terminated SID string, bounded here.
            unsafe { *raw_string.add(index) == 0 }
        })
        .ok_or_else(|| io::Error::other("Windows SID string is too long"))?;
    // SAFETY: We found the terminator within the allocation above.
    let sid = String::from_utf16(unsafe { std::slice::from_raw_parts(raw_string, length) })
        .map_err(io::Error::other)?;
    // Explicit ownership keeps elevated and ordinary same-user servers on the
    // same fast-path identity check, including after an in-place upgrade.
    let sddl = format!("O:{sid}D:P(A;;GA;;;SY)(A;;GA;;;{sid})");
    Ok(sddl.encode_utf16().chain(std::iter::once(0)).collect())
}

pub(super) fn create_private_server(
    options: &ServerOptions,
    name: &str,
) -> io::Result<NamedPipeServer> {
    let sddl = current_user_sddl()?;
    let mut raw_descriptor = ptr::null_mut();
    // SAFETY: The SDDL is NUL-terminated and the descriptor slot is writable.
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &raw mut raw_descriptor,
            ptr::null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let _descriptor = LocalAllocation(raw_descriptor);
    let mut attrs = SECURITY_ATTRIBUTES {
        nLength: u32::try_from(size_of::<SECURITY_ATTRIBUTES>())
            .expect("SECURITY_ATTRIBUTES fits a DWORD"),
        lpSecurityDescriptor: raw_descriptor,
        bInheritHandle: 0,
    };
    // SAFETY: `attrs` points to a valid descriptor for the duration of CreateNamedPipe.
    unsafe { options.create_with_security_attributes_raw(name, (&raw mut attrs).cast()) }
}

#[cfg(test)]
mod tests {
    use std::net::UdpSocket;
    use std::os::windows::io::AsRawHandle;

    use tokio::net::windows::named_pipe::{ClientOptions, ServerOptions};

    #[test]
    fn dns_hostname_distinct_from_netbios_and_fqdn_is_local() {
        super::TEST_DNS_HOSTNAME.with(|name| name.set(Some("prime-agent-dns-only-test")));
        let recognized =
            super::is_built_in_name(r"\\prime-agent-dns-only-test\pipe\prime-agent-daemon");
        super::TEST_DNS_HOSTNAME.with(|name| name.set(None));
        assert!(
            recognized,
            "the OS DNS hostname can differ from NetBIOS and FQDN"
        );
    }

    #[tokio::test]
    async fn probe_local_adapter_ip_alias_reaches_reserved_pipe() {
        let route = UdpSocket::bind("0.0.0.0:0").expect("IPv4 route probe");
        route.connect("8.8.8.8:80").expect("outbound IPv4 route");
        let ip = route.local_addr().expect("adapter address").ip();
        assert!(!ip.is_loopback(), "probe needs a non-loopback adapter");
        let suffix = format!(
            "prime-agent-worker-{:012x}-000000000004",
            std::process::id()
        );
        let canonical = format!(r"\\.\pipe\{suffix}");
        let alias = format!(r"\\{ip}\pipe\{suffix}");
        let _server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&canonical)
            .expect("local server");
        ClientOptions::new()
            .open(&alias)
            .unwrap_or_else(|error| panic!("local adapter alias {alias} did not connect: {error}"));
    }

    #[test]
    fn local_pipe_aliases_keep_reserved_names_private() {
        for name in [
            r"\\?\pipe\prime-agent-daemon",
            r"\\localhost\pipe\prime-agent-daemon",
            r"\\.\pipe/prime-agent-daemon",
            r"\\localhost/pipe/prime-agent-daemon",
        ] {
            assert!(super::is_built_in_name(name), "local alias: {name}");
        }
        assert!(
            !super::is_built_in_name(r"\\other-host\pipe\prime-agent-daemon"),
            "a genuinely remote custom pipe retains its former policy"
        );
    }

    #[tokio::test]
    async fn client_handle_identifies_same_user_server_process() {
        let name = format!(
            r"\\.\pipe\prime-agent-pa-types-server-pid-{}",
            std::process::id()
        );
        let _server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&name)
            .expect("test server");
        let client = ClientOptions::new().open(&name).expect("test client");
        let current = super::current_user().expect("current token user");
        assert!(
            super::server_process_user_matches(client.as_raw_handle(), current.sid())
                .expect("client handle identifies server process"),
            "a client handle must identify this server process"
        );
    }
}
