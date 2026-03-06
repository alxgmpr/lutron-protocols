"""
LLDB script to intercept decrypted TLS traffic from the Lutron app.

Usage:
  # Make sure Lutron app is running first, then:
  sudo lldb -n Lutron -o "command script import tools/leap-lldb-intercept.py"
"""

import lldb

def ssl_write_handler(frame, bp_loc, dict):
    """Hooked on SSL_write — dumps outgoing plaintext."""
    thread = frame.GetThread()
    process = thread.GetProcess()

    # SSL_write(ssl, buf, num) — buf is arg2, num is arg3
    buf = frame.FindRegister("x1").GetValueAsUnsigned()  # ARM64: x1 = 2nd arg
    num = frame.FindRegister("x2").GetValueAsUnsigned()  # ARM64: x2 = 3rd arg

    if num > 0 and num < 65536:
        error = lldb.SBError()
        data = process.ReadMemory(buf, num, error)
        if error.Success() and data:
            try:
                text = data.decode("utf-8", errors="replace")
                print(f"\n\033[33m>>> APP SENDS ({num} bytes):\033[0m")
                for line in text.strip().split("\r\n"):
                    if line.strip():
                        print(f"  {line}")
            except:
                print(f"\n\033[33m>>> APP SENDS ({num} bytes): [binary]\033[0m")


def ssl_read_handler(frame, bp_loc, dict):
    """Hooked on SSL_read return — dumps incoming plaintext."""
    # We need to hook the RETURN to get the data after it's been read
    # Set up a finish breakpoint
    thread = frame.GetThread()

    # Save buf pointer for the finish handler
    buf = frame.FindRegister("x1").GetValueAsUnsigned()
    thread.SetStopInfo(thread.GetStopInfo())

    # Store buf in thread's selected frame user data via global
    global _ssl_read_buf
    _ssl_read_buf = buf


_ssl_read_buf = 0


def ssl_read_return_handler(frame, bp_loc, dict):
    """Called after SSL_read returns to read the buffer."""
    global _ssl_read_buf
    thread = frame.GetThread()
    process = thread.GetProcess()

    # Return value in x0
    ret = frame.FindRegister("x0").GetValueAsUnsigned()

    # Treat as signed — if negative, it's an error
    if ret > 0x7FFFFFFF:
        return

    if ret > 0 and ret < 65536 and _ssl_read_buf:
        error = lldb.SBError()
        data = process.ReadMemory(_ssl_read_buf, ret, error)
        if error.Success() and data:
            try:
                text = data.decode("utf-8", errors="replace")
                print(f"\n\033[36m<<< APP RECEIVES ({ret} bytes):\033[0m")
                for line in text.strip().split("\r\n"):
                    if line.strip():
                        print(f"  {line}")
            except:
                print(f"\n\033[36m<<< APP RECEIVES ({ret} bytes): [binary]\033[0m")


def setup_breakpoints(debugger, command, result, dict):
    """Set breakpoints on SSL_write and SSL_read."""
    target = debugger.GetSelectedTarget()

    # Try BoringSSL/OpenSSL symbols
    for func_name in ["SSL_write", "SSL_read"]:
        bp = target.BreakpointCreateByName(func_name)
        if bp.GetNumLocations() > 0:
            if func_name == "SSL_write":
                bp.SetScriptCallbackFunction("leap_lldb_intercept.ssl_write_handler")
                bp.SetAutoContinue(True)
                print(f"[+] Hooked {func_name} ({bp.GetNumLocations()} locations)")
            elif func_name == "SSL_read":
                bp.SetScriptCallbackFunction("leap_lldb_intercept.ssl_read_handler")
                bp.SetAutoContinue(True)
                print(f"[+] Hooked {func_name} ({bp.GetNumLocations()} locations)")
        else:
            print(f"[-] {func_name} not found")

    # For SSL_read we also need to catch the return
    # Use a breakpoint on the instruction after SSL_read call
    # Alternative: use SSLRead/SSLWrite from Security.framework
    for func_name in ["SSLWrite", "SSLRead"]:
        bp = target.BreakpointCreateByName(func_name, "Security")
        if bp.GetNumLocations() > 0:
            if "Write" in func_name:
                bp.SetScriptCallbackFunction("leap_lldb_intercept.ssl_write_handler")
                bp.SetAutoContinue(True)
            else:
                bp.SetScriptCallbackFunction("leap_lldb_intercept.ssl_read_handler")
                bp.SetAutoContinue(True)
            print(f"[+] Hooked {func_name} ({bp.GetNumLocations()} locations)")
        else:
            print(f"[-] {func_name} not found in Security.framework")

    print("\n[*] Continuing process — interact with the Lutron app to see LEAP traffic\n")
    debugger.HandleCommand("continue")


def __lldb_init_module(debugger, dict):
    debugger.HandleCommand(
        "command script add -f leap_lldb_intercept.setup_breakpoints leap_intercept"
    )
    print("[*] Loaded LEAP intercept script. Run 'leap_intercept' to set hooks.")
    # Auto-run
    setup_breakpoints(debugger, None, None, dict)
