/* Linux/x86-64 raw entry prelude. No libc, allocation, writable globals, or output. */
.text
.globl _start
.type _start,@function
.set LOCAL_SIZE, 2048
.set SAVED_SIZE, 128
.set ORIGINAL_STACK, LOCAL_SIZE + SAVED_SIZE
_start:
  pushfq
  push %rax
  push %rbx
  push %rcx
  push %rdx
  push %rsi
  push %rdi
  push %rbp
  push %r8
  push %r9
  push %r10
  push %r11
  push %r12
  push %r13
  push %r14
  push %r15
  sub $LOCAL_SIZE,%rsp
  mov %rsp,%rbp
  cld

  /* Dumpability is the first raw process fact checked after saving loader ABI state. */
  mov $157,%eax
  mov $3,%edi
  xor %esi,%esi
  xor %edx,%edx
  xor %r10d,%r10d
  xor %r8d,%r8d
  syscall
  test %eax,%eax
  jnz fail

  /* Exact argc, argv, empty env, and bounded AT_SECURE auxv. */
  lea ORIGINAL_STACK(%rbp),%rbx
  cmpq $2,0(%rbx)
  jne fail
  mov 8(%rbx),%rdi
  lea binary_path(%rip),%rsi
  call string_equal
  test %eax,%eax
  jz fail
  mov 16(%rbx),%rdi
  lea script_path(%rip),%rsi
  call string_equal
  test %eax,%eax
  jz fail
  cmpq $0,24(%rbx)
  jne fail
  cmpq $0,32(%rbx)
  jne fail
  lea 40(%rbx),%r12
  xor %r13d,%r13d
  mov $64,%ecx
aux_loop:
  test %ecx,%ecx
  jz fail
  mov 0(%r12),%rax
  test %rax,%rax
  jz aux_done
  cmp $23,%rax
  jne aux_next
  test %r13d,%r13d
  jnz fail
  cmpq $1,8(%r12)
  jne fail
  mov $1,%r13d
aux_next:
  add $16,%r12
  dec %ecx
  jmp aux_loop
aux_done:
  test %r13d,%r13d
  jz fail

  /* Every pathname prefix is root-owned and not writable by group or other. */
  lea opt_path(%rip),%rdi
  call verify_root_directory
  test %eax,%eax
  jz fail
  lea runtime_dir_path(%rip),%rdi
  call verify_root_directory
  test %eax,%eax
  jz fail

  /* The fixed coding script is a single root-owned, non-writable regular file. */
  mov $257,%eax
  mov $-100,%edi
  lea script_path(%rip),%rsi
  mov $0xa0000,%edx
  xor %r10d,%r10d
  syscall
  test %eax,%eax
  js fail
  mov %eax,%r15d
  mov $5,%eax
  mov %r15d,%edi
  lea 32(%rbp),%rsi
  syscall
  test %eax,%eax
  jnz fail_close_script
  cmpl $0100444,56(%rbp)
  jne fail_close_script
  cmpq $1,48(%rbp)
  jne fail_close_script
  cmpl $0,60(%rbp)
  jne fail_close_script
  cmpl $0,64(%rbp)
  jne fail_close_script
  mov $3,%eax
  mov %r15d,%edi
  syscall
  test %eax,%eax
  jnz fail

  /* Kernel secure-exec identity and dumpability. */
  mov $157,%eax
  mov $3,%edi
  xor %esi,%esi
  xor %edx,%edx
  xor %r10d,%r10d
  xor %r8d,%r8d
  syscall
  test %eax,%eax
  jnz fail
  mov $118,%eax
  lea 0(%rbp),%rdi
  lea 4(%rbp),%rsi
  lea 8(%rbp),%rdx
  syscall
  test %eax,%eax
  jnz fail
  cmpl $65534,0(%rbp)
  jne fail
  cmpl $65534,4(%rbp)
  jne fail
  cmpl $65534,8(%rbp)
  jne fail
  mov $122,%eax
  mov $-1,%edi
  syscall
  cmp $65534,%eax
  jne fail
  mov $120,%eax
  lea 12(%rbp),%rdi
  lea 16(%rbp),%rsi
  lea 20(%rbp),%rdx
  syscall
  test %eax,%eax
  jnz fail
  cmpl $65534,12(%rbp)
  jne fail
  cmpl $65533,16(%rbp)
  jne fail
  cmpl $65533,20(%rbp)
  jne fail
  mov $123,%eax
  mov $-1,%edi
  syscall
  cmp $65533,%eax
  jne fail
  mov $115,%eax
  xor %edi,%edi
  xor %esi,%esi
  syscall
  test %eax,%eax
  jnz fail

  /* All capability vectors, bounding bits, and ambient bits are empty. */
  movl $0x20080522,176(%rbp)
  movl $0,180(%rbp)
  movq $0,184(%rbp)
  movq $0,192(%rbp)
  movq $0,200(%rbp)
  mov $125,%eax
  lea 176(%rbp),%rdi
  lea 184(%rbp),%rsi
  syscall
  test %eax,%eax
  jnz fail
  mov 184(%rbp),%rax
  or 192(%rbp),%rax
  or 200(%rbp),%rax
  jnz fail
  xor %r12d,%r12d
cap_loop:
  mov $157,%eax
  mov $23,%edi
  mov %r12d,%esi
  xor %edx,%edx
  xor %r10d,%r10d
  xor %r8d,%r8d
  syscall
  test %eax,%eax
  jnz fail
  mov $157,%eax
  mov $47,%edi
  mov $1,%esi
  mov %r12d,%edx
  xor %r10d,%r10d
  xor %r8d,%r8d
  syscall
  test %eax,%eax
  jnz fail
  inc %r12d
  cmp $41,%r12d
  jne cap_loop
  mov $157,%eax
  mov $23,%edi
  mov $41,%esi
  xor %edx,%edx
  xor %r10d,%r10d
  xor %r8d,%r8d
  syscall
  cmp $-22,%eax
  jne fail
  mov $157,%eax
  mov $47,%edi
  mov $1,%esi
  mov $41,%edx
  xor %r10d,%r10d
  xor %r8d,%r8d
  syscall
  cmp $-22,%eax
  jne fail

  /* Seal the inherited range first, close everything above fd 3, then validate. */
  mov $436,%eax
  mov $3,%edi
  mov $-1,%esi
  mov $4,%edx
  syscall
  test %eax,%eax
  jnz fail
  mov $436,%eax
  mov $4,%edi
  mov $-1,%esi
  xor %edx,%edx
  syscall
  test %eax,%eax
  jnz fail
  mov $72,%eax
  mov $3,%edi
  mov $2,%esi
  mov $1,%edx
  syscall
  test %eax,%eax
  jnz fail
  mov $72,%eax
  mov $3,%edi
  mov $1,%esi
  xor %edx,%edx
  syscall
  cmp $1,%eax
  jne fail
  movl $4,208(%rbp)
  mov $55,%eax
  mov $3,%edi
  mov $1,%esi
  mov $3,%edx
  lea 212(%rbp),%r10
  lea 208(%rbp),%r8
  syscall
  test %eax,%eax
  jnz fail
  cmpl $4,208(%rbp)
  jne fail
  cmpl $5,212(%rbp)
  jne fail
  movl $128,216(%rbp)
  mov $51,%eax
  mov $3,%edi
  lea 224(%rbp),%rsi
  lea 216(%rbp),%rdx
  syscall
  test %eax,%eax
  jnz fail
  cmpw $1,224(%rbp)
  jne fail
  movl $128,216(%rbp)
  mov $52,%eax
  mov $3,%edi
  lea 224(%rbp),%rsi
  lea 216(%rbp),%rdx
  syscall
  test %eax,%eax
  jnz fail
  cmpw $1,224(%rbp)
  jne fail
  movl $1,212(%rbp)
  mov $54,%eax
  mov $3,%edi
  mov $1,%esi
  mov $16,%edx
  lea 212(%rbp),%r10
  mov $4,%r8d
  syscall
  test %eax,%eax
  jnz fail
  movl $4,208(%rbp)
  mov $55,%eax
  mov $3,%edi
  mov $1,%esi
  mov $16,%edx
  lea 212(%rbp),%r10
  lea 208(%rbp),%r8
  syscall
  test %eax,%eax
  jnz fail
  cmpl $4,208(%rbp)
  jne fail
  cmpl $1,212(%rbp)
  jne fail

  /* No standard descriptor may alias the validated fd 3 socket endpoint. */
  mov $5,%eax
  mov $3,%edi
  lea 32(%rbp),%rsi
  syscall
  test %eax,%eax
  jnz fail
  xor %r12d,%r12d
stdio_identity_loop:
  mov $5,%eax
  mov %r12d,%edi
  lea 1056(%rbp),%rsi
  syscall
  test %eax,%eax
  jnz fail
  mov 32(%rbp),%rax
  cmp 1056(%rbp),%rax
  jne stdio_identity_next
  mov 40(%rbp),%rax
  cmp 1064(%rbp),%rax
  je fail
stdio_identity_next:
  inc %r12d
  cmp $3,%r12d
  jne stdio_identity_loop

  /* Permanently discard the setgid effective and saved identity. */
  mov $119,%eax
  mov $65534,%edi
  mov $65534,%esi
  mov $65534,%edx
  syscall
  test %eax,%eax
  jnz fail
  mov $120,%eax
  lea 12(%rbp),%rdi
  lea 16(%rbp),%rsi
  lea 20(%rbp),%rdx
  syscall
  test %eax,%eax
  jnz fail
  cmpl $65534,12(%rbp)
  jne fail
  cmpl $65534,16(%rbp)
  jne fail
  cmpl $65534,20(%rbp)
  jne fail
  mov $123,%eax
  mov $-1,%edi
  syscall
  cmp $65534,%eax
  jne fail
  mov $157,%eax
  mov $3,%edi
  xor %esi,%esi
  xor %edx,%edx
  xor %r10d,%r10d
  xor %r8d,%r8d
  syscall
  test %eax,%eax
  jnz fail
  mov $157,%eax
  mov $0x59616d61,%edi
  xor %esi,%esi
  xor %edx,%edx
  xor %r10d,%r10d
  xor %r8d,%r8d
  syscall
  test %eax,%eax
  jnz fail
  mov $157,%eax
  mov $38,%edi
  mov $1,%esi
  xor %edx,%edx
  xor %r10d,%r10d
  xor %r8d,%r8d
  syscall
  test %eax,%eax
  jnz fail
  mov $157,%eax
  mov $39,%edi
  xor %esi,%esi
  xor %edx,%edx
  xor %r10d,%r10d
  xor %r8d,%r8d
  syscall
  cmp $1,%eax
  jne fail

  /* cwd=/ and pid=pgrp=sid. */
  mov $79,%eax
  lea 352(%rbp),%rdi
  mov $8,%esi
  syscall
  cmp $2,%eax
  jne fail
  cmpw $0x002f,352(%rbp)
  jne fail
  mov $39,%eax
  syscall
  mov %eax,%r13d
  mov $111,%eax
  syscall
  cmp %r13d,%eax
  jne fail
  mov $124,%eax
  xor %edi,%edi
  syscall
  cmp %r13d,%eax
  jne fail

  /* Classic same-thread parent-death arm and parent recheck. */
  mov $110,%eax
  syscall
  cmp $1,%eax
  jle fail
  mov %eax,%r14d
  mov $157,%eax
  mov $1,%edi
  mov $9,%esi
  xor %edx,%edx
  xor %r10d,%r10d
  xor %r8d,%r8d
  syscall
  test %eax,%eax
  jnz fail
  movl $0,208(%rbp)
  mov $157,%eax
  mov $2,%edi
  lea 208(%rbp),%rsi
  xor %edx,%edx
  xor %r10d,%r10d
  xor %r8d,%r8d
  syscall
  test %eax,%eax
  jnz fail
  cmpl $9,208(%rbp)
  jne fail
  mov $110,%eax
  syscall
  cmp %r14d,%eax
  jne fail

  /* Read the exact starttime field for the dynamic canonical HELLO. */
  mov $257,%eax
  mov $-100,%edi
  lea self_stat_path(%rip),%rsi
  mov $0xa0000,%edx
  xor %r10d,%r10d
  syscall
  test %eax,%eax
  js fail
  mov %eax,%r15d
  xor %eax,%eax
  mov %r15d,%edi
  lea 1056(%rbp),%rsi
  mov $768,%edx
  syscall
  test %eax,%eax
  jle fail_close_script
  cmp $768,%eax
  je fail_close_script
  mov %eax,%r11d
  mov $3,%eax
  mov %r15d,%edi
  syscall
  test %eax,%eax
  jnz fail
  lea 1056(%rbp),%rsi
  lea 1056(%rbp,%r11),%rdi
find_stat_comm_end:
  cmp %rdi,%rsi
  jae fail
  cmpb $')',(%rsi)
  jne stat_next_byte
  lea 2(%rsi),%rax
  cmp %rdi,%rax
  jae fail
  cmpb $' ',1(%rsi)
  je stat_fields_start
stat_next_byte:
  inc %rsi
  jmp find_stat_comm_end
stat_fields_start:
  add $2,%rsi
  inc %rsi
  cmp %rdi,%rsi
  jae fail
  cmpb $' ',(%rsi)
  jne fail
  inc %rsi
  mov $4,%ecx
stat_field_loop:
  cmp %rdi,%rsi
  jae fail
  xor %r8d,%r8d
  cmpb $'-',(%rsi)
  jne stat_digits
  mov $1,%r8d
  inc %rsi
stat_digits:
  xor %eax,%eax
  xor %r9d,%r9d
stat_digit_loop:
  cmp %rdi,%rsi
  jae fail
  movzbl (%rsi),%edx
  sub $'0',%edx
  cmp $9,%edx
  ja stat_field_end
  imul $10,%rax,%rax
  jo fail
  add %rdx,%rax
  jo fail
  inc %rsi
  inc %r9d
  jmp stat_digit_loop
stat_field_end:
  test %r9d,%r9d
  jz fail
  cmp $22,%ecx
  je stat_starttime
  cmpb $' ',(%rsi)
  jne fail
  inc %rsi
  inc %ecx
  jmp stat_field_loop
stat_starttime:
  test %r8d,%r8d
  jnz fail
  mov %rax,840(%rbp)

  /* Exact framed fresh CHALLENGE, dynamic HELLO, and credentialed READY. */
  call prepare_recvmsg
  mov $47,%eax
  mov $3,%edi
  lea 672(%rbp),%rsi
  mov $0x40000000,%edx
  syscall
  cmp $112,%eax
  jne fail
  call validate_credentials
  test %eax,%eax
  jz fail
  lea 368(%rbp),%rdi
  lea challenge_header(%rip),%rsi
  mov $6,%ecx
  repe cmpsq
  jne fail
  lea hello_header(%rip),%rsi
  lea 864(%rbp),%rdi
  mov $6,%ecx
  rep movsq
  lea 416(%rbp),%rsi
  mov $8,%ecx
  rep movsq
  lea coding_digest(%rip),%rsi
  mov $4,%ecx
  rep movsq
  mov %r13d,%eax
  bswap %eax
  mov %eax,1008(%rbp)
  mov %r14d,%eax
  bswap %eax
  mov %eax,1012(%rbp)
  mov $111,%eax
  syscall
  bswap %eax
  mov %eax,1016(%rbp)
  mov $124,%eax
  xor %edi,%edi
  syscall
  bswap %eax
  mov %eax,1020(%rbp)
  mov 840(%rbp),%rax
  bswap %rax
  mov %rax,1024(%rbp)
  mov $65534,%eax
  bswap %eax
  mov %eax,1032(%rbp)
  mov %eax,1036(%rbp)
  mov $44,%eax
  mov $3,%edi
  lea 864(%rbp),%rsi
  mov $176,%edx
  mov $0x4000,%r10d
  xor %r8d,%r8d
  xor %r9d,%r9d
  syscall
  cmp $176,%eax
  jne fail
  call prepare_recvmsg
  mov $47,%eax
  mov $3,%edi
  lea 672(%rbp),%rsi
  mov $0x40000000,%edx
  syscall
  cmp $48,%eax
  jne fail
  call validate_credentials
  test %eax,%eax
  jz fail
  lea 368(%rbp),%rdi
  lea ready_header(%rip),%rsi
  mov $6,%ecx
  repe cmpsq
  jne fail

  /* Final invariant checks before returning to Bun's original entry. */
  mov $118,%eax
  lea 0(%rbp),%rdi
  lea 4(%rbp),%rsi
  lea 8(%rbp),%rdx
  syscall
  test %eax,%eax
  jnz fail
  cmpl $65534,0(%rbp)
  jne fail
  cmpl $65534,4(%rbp)
  jne fail
  cmpl $65534,8(%rbp)
  jne fail
  mov $122,%eax
  mov $-1,%edi
  syscall
  cmp $65534,%eax
  jne fail
  mov $120,%eax
  lea 12(%rbp),%rdi
  lea 16(%rbp),%rsi
  lea 20(%rbp),%rdx
  syscall
  test %eax,%eax
  jnz fail
  cmpl $65534,12(%rbp)
  jne fail
  cmpl $65534,16(%rbp)
  jne fail
  cmpl $65534,20(%rbp)
  jne fail
  mov $123,%eax
  mov $-1,%edi
  syscall
  cmp $65534,%eax
  jne fail
  mov $115,%eax
  xor %edi,%edi
  xor %esi,%esi
  syscall
  test %eax,%eax
  jnz fail
  movq $0,184(%rbp)
  movq $0,192(%rbp)
  movq $0,200(%rbp)
  mov $125,%eax
  lea 176(%rbp),%rdi
  lea 184(%rbp),%rsi
  syscall
  test %eax,%eax
  jnz fail
  mov 184(%rbp),%rax
  or 192(%rbp),%rax
  or 200(%rbp),%rax
  jnz fail
  xor %r12d,%r12d
final_cap_loop:
  mov $157,%eax
  mov $23,%edi
  mov %r12d,%esi
  xor %edx,%edx
  xor %r10d,%r10d
  xor %r8d,%r8d
  syscall
  test %eax,%eax
  jnz fail
  mov $157,%eax
  mov $47,%edi
  mov $1,%esi
  mov %r12d,%edx
  xor %r10d,%r10d
  xor %r8d,%r8d
  syscall
  test %eax,%eax
  jnz fail
  inc %r12d
  cmp $41,%r12d
  jne final_cap_loop
  mov $157,%eax
  mov $39,%edi
  xor %esi,%esi
  xor %edx,%edx
  xor %r10d,%r10d
  xor %r8d,%r8d
  syscall
  cmp $1,%eax
  jne fail
  mov $110,%eax
  syscall
  cmp %r14d,%eax
  jne fail
  mov $157,%eax
  mov $3,%edi
  xor %esi,%esi
  xor %edx,%edx
  xor %r10d,%r10d
  xor %r8d,%r8d
  syscall
  test %eax,%eax
  jnz fail
  mov $72,%eax
  mov $3,%edi
  mov $1,%esi
  xor %edx,%edx
  syscall
  cmp $1,%eax
  jne fail

  mov %rbp,%rsp
  add $LOCAL_SIZE,%rsp
  pop %r15
  pop %r14
  pop %r13
  pop %r12
  pop %r11
  pop %r10
  pop %r9
  pop %r8
  pop %rbp
  pop %rdi
  pop %rsi
  pop %rdx
  pop %rcx
  pop %rbx
  pop %rax
  popfq
  jmp *original_entry(%rip)

fail_close_script:
  mov $3,%eax
  mov %r15d,%edi
  syscall
fail:
  mov $3,%eax
  mov $3,%edi
  syscall
  mov $231,%eax
  mov $126,%edi
  syscall
  hlt

/* Verify one fixed directory as root:root mode 0755 without following its final link. */
verify_root_directory:
  mov %rdi,%rsi
  mov $257,%eax
  mov $-100,%edi
  mov $0x2b0000,%edx
  xor %r10d,%r10d
  syscall
  test %eax,%eax
  js verify_directory_no
  mov %eax,%r15d
  mov $5,%eax
  mov %r15d,%edi
  lea 32(%rbp),%rsi
  syscall
  mov %eax,%r12d
  mov $3,%eax
  mov %r15d,%edi
  syscall
  test %eax,%eax
  jnz verify_directory_no
  test %r12d,%r12d
  jnz verify_directory_no
  cmpl $0040755,56(%rbp)
  jne verify_directory_no
  cmpl $0,60(%rbp)
  jne verify_directory_no
  cmpl $0,64(%rbp)
  jne verify_directory_no
  mov $1,%eax
  ret
verify_directory_no:
  xor %eax,%eax
  ret

/* Returns eax=1 only for byte-identical NUL-terminated strings. */
string_equal:
  mov $512,%ecx
string_loop:
  movzbl (%rdi),%eax
  cmpb (%rsi),%al
  jne string_no
  test %al,%al
  jz string_yes
  inc %rdi
  inc %rsi
  dec %ecx
  jnz string_loop
string_no:
  xor %eax,%eax
  ret
string_yes:
  mov $1,%eax
  ret

/* Receive storage: data=368, iovec=640, msghdr=672, control=736. */
prepare_recvmsg:
  lea 368(%rbp),%rax
  mov %rax,640(%rbp)
  movq $176,648(%rbp)
  lea 672(%rbp),%rdi
  xor %eax,%eax
  mov $7,%ecx
  rep stosq
  lea 640(%rbp),%rax
  mov %rax,688(%rbp)
  movq $1,696(%rbp)
  lea 736(%rbp),%rax
  mov %rax,704(%rbp)
  movq $128,712(%rbp)
  ret

/* Close every received right, then accept exactly one root-parent credential object. */
validate_credentials:
  movl $0,832(%rbp)
  movl $0,836(%rbp)
  mov 720(%rbp),%eax
  and $0xbfffffff,%eax
  jz credentials_flags_ok
  movl $1,832(%rbp)
credentials_flags_ok:
  mov 712(%rbp),%r11
  mov %r11,848(%rbp)
  cmp $128,%r11
  ja credentials_no
  xor %r12d,%r12d
credentials_loop:
  cmp %r11,%r12
  je credentials_done
  mov %r11,%rax
  sub %r12,%rax
  cmp $16,%rax
  jb credentials_no
  lea 736(%rbp,%r12),%r10
  mov 0(%r10),%r15
  cmp $16,%r15
  jb credentials_no
  mov %r12,%rax
  add %r15,%rax
  jc credentials_no
  cmp %r11,%rax
  ja credentials_no
  cmpl $1,8(%r10)
  jne credentials_unknown
  cmpl $1,12(%r10)
  je credentials_rights
  cmpl $2,12(%r10)
  je credentials_object
credentials_unknown:
  movl $1,832(%rbp)
  jmp credentials_advance
credentials_rights:
  movl $1,832(%rbp)
  mov %r15,%rax
  sub $16,%rax
  test $3,%eax
  jnz credentials_advance
  lea 16(%r10),%rsi
credentials_rights_loop:
  test %rax,%rax
  jz credentials_advance
  mov %rax,%rdx
  mov (%rsi),%edi
  mov $3,%eax
  syscall
  mov %rdx,%rax
  add $4,%rsi
  sub $4,%rax
  jmp credentials_rights_loop
credentials_object:
  cmp $28,%r15
  jne credentials_unknown
  cmpl $0,836(%rbp)
  jne credentials_unknown
  movl $1,836(%rbp)
  mov 16(%r10),%eax
  cmp %r14d,%eax
  jne credentials_bad_object
  cmpl $0,20(%r10)
  jne credentials_bad_object
  cmpl $0,24(%r10)
  jne credentials_bad_object
  jmp credentials_advance
credentials_bad_object:
  movl $1,832(%rbp)
credentials_advance:
  mov 848(%rbp),%r11
  lea 7(%r15),%rax
  and $-8,%rax
  add %rax,%r12
  jc credentials_no
  cmp %r11,%r12
  jbe credentials_loop
credentials_no:
  xor %eax,%eax
  ret
credentials_done:
  cmpl $0,832(%rbp)
  jne credentials_no
  cmpl $1,836(%rbp)
  jne credentials_no
  cmpq $32,712(%rbp)
  jne credentials_no
  mov $1,%eax
  ret

.align 8
opt_path: .asciz "/opt"
runtime_dir_path: .asciz "/opt/prime-agent-sandbox-v26"
binary_path: .asciz "/opt/prime-agent-sandbox-v26/prime-agent"
script_path: .asciz "/opt/prime-agent-sandbox-v26/prime-agent-coding-v26.js"
self_stat_path: .asciz "/proc/self/stat"
.align 8
challenge_header: .byte 0x50,0x41,0x52,0x49,0x50,0x56,0x32,0x35,0x01,0x01,0xff,0x00,0x00,0x00,0x00,0x40,0x00,0x00,0x00,0x40,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x00
hello_header: .byte 0x50,0x41,0x52,0x49,0x50,0x56,0x32,0x35,0x01,0x02,0xff,0x00,0x00,0x00,0x00,0x80,0x00,0x00,0x00,0x80,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x00
ready_header: .byte 0x50,0x41,0x52,0x49,0x50,0x56,0x32,0x35,0x01,0x03,0xff,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x02,0x00,0x00,0x00,0x00
/* The release builder replaces this exact 32-byte template sentinel once. */
coding_digest: .ascii "PA_V26_CODING_DIGEST_PLACEHOLDER"
.align 8
original_entry: .quad 0x17bf400
.size _start,.-_start
.section .note.GNU-stack,"",@progbits
