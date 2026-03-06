/**
 * Frida script to intercept decrypted TLS traffic from the Lutron iOS/Catalyst app.
 *
 * Usage:
 *   .venv/bin/frida -n Lutron -l tools/leap-frida.js
 *
 * Hooks SSLRead/SSLWrite (SecureTransport) and SSL_read/SSL_write (OpenSSL/BoringSSL)
 * to capture plaintext LEAP JSON after TLS decryption.
 */

// Hook Apple SecureTransport
try {
  var SSLWrite = Module.findExportByName("Security", "SSLWrite");
  var SSLRead = Module.findExportByName("Security", "SSLRead");

  if (SSLWrite) {
    Interceptor.attach(SSLWrite, {
      onEnter: function (args) {
        this.data = args[1];
        this.len = args[2].toInt32();
      },
      onLeave: function (retval) {
        if (this.len > 0) {
          var buf = Memory.readUtf8String(this.data, this.len);
          if (buf) {
            send({ type: "send", direction: ">>>", data: buf });
          }
        }
      },
    });
    console.log("[+] Hooked SSLWrite (SecureTransport)");
  }

  if (SSLRead) {
    Interceptor.attach(SSLRead, {
      onEnter: function (args) {
        this.data = args[1];
        this.lenPtr = args[3]; // processed pointer
      },
      onLeave: function (retval) {
        if (retval.toInt32() === 0 && this.lenPtr) {
          var len = Memory.readUInt(this.lenPtr);
          if (len > 0) {
            var buf = Memory.readUtf8String(this.data, len);
            if (buf) {
              send({ type: "recv", direction: "<<<", data: buf });
            }
          }
        }
      },
    });
    console.log("[+] Hooked SSLRead (SecureTransport)");
  }
} catch (e) {
  console.log("[-] SecureTransport hooks failed: " + e);
}

// Hook OpenSSL / BoringSSL
try {
  var libs = ["libssl.dylib", "libboringssl.dylib", null];
  libs.forEach(function (lib) {
    var ssl_write = Module.findExportByName(lib, "SSL_write");
    var ssl_read = Module.findExportByName(lib, "SSL_read");

    if (ssl_write) {
      Interceptor.attach(ssl_write, {
        onEnter: function (args) {
          this.buf = args[1];
          this.len = args[2].toInt32();
        },
        onLeave: function (retval) {
          var n = retval.toInt32();
          if (n > 0) {
            var buf = Memory.readUtf8String(this.buf, n);
            if (buf) {
              send({
                type: "send",
                direction: ">>>",
                lib: lib || "default",
                data: buf,
              });
            }
          }
        },
      });
      console.log("[+] Hooked SSL_write in " + (lib || "default"));
    }

    if (ssl_read) {
      Interceptor.attach(ssl_read, {
        onEnter: function (args) {
          this.buf = args[1];
        },
        onLeave: function (retval) {
          var n = retval.toInt32();
          if (n > 0) {
            var buf = Memory.readUtf8String(this.buf, n);
            if (buf) {
              send({
                type: "recv",
                direction: "<<<",
                lib: lib || "default",
                data: buf,
              });
            }
          }
        },
      });
      console.log("[+] Hooked SSL_read in " + (lib || "default"));
    }
  });
} catch (e) {
  console.log("[-] OpenSSL/BoringSSL hooks failed: " + e);
}

// Also try nw_* (Network.framework) which is common in modern iOS/Catalyst apps
try {
  var nw_framer_deliver_input = Module.findExportByName(
    "libnetwork.dylib",
    "nw_framer_deliver_input",
  );
  if (nw_framer_deliver_input) {
    console.log("[+] Found nw_framer_deliver_input (Network.framework)");
  }
} catch (e) {}

console.log("\n[*] Waiting for LEAP traffic...\n");
