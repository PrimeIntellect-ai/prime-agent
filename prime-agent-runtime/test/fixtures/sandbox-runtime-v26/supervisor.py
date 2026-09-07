#!/usr/bin/env python3
"""Offline root supervisor for V26 container tests. It performs no provider action."""
import argparse
import ctypes
import os
import socket
import struct
import time

SCRIPT = "/opt/prime-agent-sandbox-v26/prime-agent-coding-v26.js"
BINARY = "/opt/prime-agent-sandbox-v26/prime-agent"
DIGEST = bytes.fromhex("3a5e2cf2e6659052b3bd8f9eac3b8cdf3ce33fdfccb65963293ffe8d3383bea6")
libc = ctypes.CDLL(None, use_errno=True)
PR_CAPBSET_DROP = 24

def header(kind, length, sequence):
    return (b"PARIPV25" + bytes((1, kind, 0xFF, 0)) +
            struct.pack(">IIIHHQQI", length, length, 0, 0, 1, 0, sequence, 0))

def child(sock, mode):
    os.dup2(sock.fileno(), 3, inheritable=True)
    if sock.fileno() != 3:
        sock.close()
    if mode == "fd":
        os.close(3)
    if mode == "stdio-alias":
        os.dup2(3, 0, inheritable=True)
    os.chdir("/")
    if mode != "wrong-session":
        os.setsid()
    os.setgroups([])
    for capability in range(41):
        if mode == "caps" and capability == 0:
            continue
        if libc.prctl(PR_CAPBSET_DROP, capability, 0, 0, 0) != 0:
            os._exit(125)
    gid = 65532 if mode == "gid" else 65534
    uid = 65532 if mode == "uid" else 65534
    os.setresgid(gid, gid, gid)
    os.setresuid(uid, uid, uid)
    env = {"BAD": "1"} if mode == "env" else {}
    argv = [BINARY, "/wrong.js" if mode == "argv" else SCRIPT]
    os.execve(BINARY, argv, env)

def recv_credentials(sock, size):
    return sock.recvmsg(size, socket.CMSG_SPACE(12))

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", nargs="?", default="success")
    args = parser.parse_args()
    sock_type = socket.SOCK_STREAM if args.mode == "socket" else socket.SOCK_SEQPACKET
    parent, coding = socket.socketpair(socket.AF_UNIX, sock_type)
    parent.settimeout(10)
    for endpoint in (parent, coding):
        endpoint.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
        if endpoint.getsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED) != 1:
            raise SystemExit(125)
    pid = os.fork()
    if pid == 0:
        parent.close()
        child(coding, args.mode)
    coding.close()
    challenge_body = os.urandom(64)
    challenge = header(1, 64, 1) + challenge_body
    if args.mode == "parent":
        sender = os.fork()
        if sender == 0:
            parent.send(challenge)
            os._exit(0)
        os.waitpid(sender, 0)
    else:
        message = (b"X" * len(challenge)) if args.mode == "challenge" else challenge
        ancillary = []
        if args.mode == "rights":
            ancillary.append((socket.SOL_SOCKET, socket.SCM_RIGHTS, struct.pack("i", 1)))
        if args.mode == "credentials":
            ancillary.append((socket.SOL_SOCKET, socket.SCM_CREDENTIALS,
                              struct.pack("3i", os.getpid(), 1, 1)))
        try:
            parent.sendmsg([message], ancillary)
        except OSError:
            pass
    try:
        data, ancillary, flags, _ = recv_credentials(parent, 176)
        credentials = [struct.unpack("3i", payload) for level, kind, payload in ancillary
                       if level == socket.SOL_SOCKET and kind == socket.SCM_CREDENTIALS]
        starttime = int(open(f"/proc/{pid}/stat", encoding="ascii").read().rsplit(") ", 1)[1].split()[19])
        expected_body = (challenge_body + DIGEST +
                         struct.pack(">IIIIQII", pid, os.getpid(), pid, pid,
                                     starttime, 65534, 65534))
        expected = header(2, 128, 1) + expected_body
        if data != expected or flags or credentials != [(pid, 65534, 65534)]:
            parent.close()
        else:
            ready = header(3, 0, 2)
            parent.send((b"X" * len(ready)) if args.mode == "ready" else ready)
    except (OSError, ValueError, FileNotFoundError, socket.timeout):
        parent.close()
    deadline = 100
    while deadline:
        waited, status = os.waitpid(pid, os.WNOHANG)
        if waited == pid:
            if os.WIFEXITED(status):
                raise SystemExit(os.WEXITSTATUS(status))
            raise SystemExit(128 + os.WTERMSIG(status))
        deadline -= 1
        time.sleep(0.05)
    os.kill(pid, 9)
    os.waitpid(pid, 0)
    raise SystemExit(124)

if __name__ == "__main__":
    main()
