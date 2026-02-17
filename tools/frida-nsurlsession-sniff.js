/*
 * Live NSURLSession request sniffer for Frida.
 *
 * Logs outbound requests before they are sent (URL, method, headers, body).
 * Intended for reverse engineering app-to-processor API routes before TLS.
 *
 * Usage:
 *   . .venv-frida/bin/activate
 *   frida -p <pid> -l tools/frida-nsurlsession-sniff.js -q
 */

"use strict";

if (!ObjC.available) {
  send({ type: "error", message: "Objective-C runtime is not available" });
  throw new Error("ObjC runtime unavailable");
}

const MAX_BODY_BYTES = 8192;
const uploadBodyByTaskPtr = {};

function safeToString(v) {
  if (v === null || v === undefined) return null;
  try {
    return v.toString();
  } catch (_) {
    return "<unprintable>";
  }
}

function nsDataToUtf8OrBase64(nsDataObj) {
  if (!nsDataObj) return null;
  let length = 0;
  try {
    length = parseInt(nsDataObj.length(), 10);
  } catch (_) {
    return null;
  }
  if (length === 0) return "";

  const truncated = length > MAX_BODY_BYTES;
  let slice = nsDataObj;
  if (truncated) {
    slice = nsDataObj.subdataWithRange_({ location: 0, length: MAX_BODY_BYTES });
  }

  try {
    const utf8 = ObjC.classes.NSString.alloc().initWithData_encoding_(slice, 4); // NSUTF8StringEncoding
    if (utf8 && !utf8.isNull()) {
      const s = utf8.toString();
      return truncated ? `${s}...[truncated ${length - MAX_BODY_BYTES} bytes]` : s;
    }
  } catch (_) {
    // Fallback below.
  }

  try {
    const b64 = slice.base64EncodedStringWithOptions_(0).toString();
    return truncated
      ? `base64:${b64}...[truncated ${length - MAX_BODY_BYTES} bytes]`
      : `base64:${b64}`;
  } catch (_) {
    return `<binary ${length} bytes>`;
  }
}

function nsDictToObject(dictObj) {
  const out = {};
  if (!dictObj || dictObj.isNull()) return out;
  try {
    const keys = dictObj.allKeys();
    const count = parseInt(keys.count(), 10);
    for (let i = 0; i < count; i++) {
      const kObj = keys.objectAtIndex_(i);
      const vObj = dictObj.objectForKey_(kObj);
      out[safeToString(kObj)] = safeToString(vObj);
    }
  } catch (e) {
    out.__error = `dict_parse_failed:${safeToString(e)}`;
  }
  return out;
}

function logRequest(taskObj, source) {
  try {
    const req = taskObj.originalRequest ? taskObj.originalRequest() : null;
    if (!req || req.isNull()) return;

    const urlObj = req.URL();
    const url = urlObj && !urlObj.isNull() ? safeToString(urlObj.absoluteString()) : null;
    const methodObj = req.HTTPMethod();
    const method = methodObj && !methodObj.isNull() ? safeToString(methodObj) : null;
    const headers = nsDictToObject(req.allHTTPHeaderFields());

    let body = null;
    const bodyObj = req.HTTPBody();
    if (bodyObj && !bodyObj.isNull()) {
      body = nsDataToUtf8OrBase64(bodyObj);
    } else {
      const taskKey = taskObj.handle.toString();
      if (uploadBodyByTaskPtr[taskKey]) {
        body = uploadBodyByTaskPtr[taskKey];
      }
    }

    send({
      type: "http_request",
      source,
      task_ptr: taskObj.handle.toString(),
      method,
      url,
      headers,
      body,
      ts: new Date().toISOString(),
    });
  } catch (e) {
    send({
      type: "error",
      source,
      message: `logRequest_failed:${safeToString(e)}`,
    });
  }
}

function attachIfExists(klass, selector, callbacks) {
  try {
    const impl = klass[selector];
    if (!impl || !impl.implementation) return false;
    Interceptor.attach(impl.implementation, callbacks);
    send({ type: "hook_attached", class: safeToString(klass), selector });
    return true;
  } catch (e) {
    send({
      type: "error",
      class: safeToString(klass),
      selector,
      message: `attach_failed:${safeToString(e)}`,
    });
    return false;
  }
}

const NSURLSessionTask = ObjC.classes.NSURLSessionTask;
const NSURLSession = ObjC.classes.NSURLSession;

if (!NSURLSessionTask || !NSURLSession) {
  send({ type: "error", message: "Required NSURLSession classes are missing" });
  throw new Error("Missing NSURLSession classes");
}

attachIfExists(NSURLSessionTask, "- resume", {
  onEnter(args) {
    try {
      const task = new ObjC.Object(args[0]);
      logRequest(task, "NSURLSessionTask.resume");
    } catch (e) {
      send({ type: "error", source: "resume", message: safeToString(e) });
    }
  },
});

attachIfExists(NSURLSession, "- uploadTaskWithRequest:fromData:completionHandler:", {
  onEnter(args) {
    this.uploadBody = null;
    try {
      const bodyArg = args[3];
      if (bodyArg && !bodyArg.isNull()) {
        this.uploadBody = nsDataToUtf8OrBase64(new ObjC.Object(bodyArg));
      }
    } catch (_) {
      this.uploadBody = null;
    }
  },
  onLeave(retval) {
    try {
      if (this.uploadBody) {
        uploadBodyByTaskPtr[retval.toString()] = this.uploadBody;
      }
    } catch (_) {
      // Ignore best-effort cache failures.
    }
  },
});

attachIfExists(NSURLSession, "- uploadTaskWithRequest:fromData:", {
  onEnter(args) {
    this.uploadBody = null;
    try {
      const bodyArg = args[3];
      if (bodyArg && !bodyArg.isNull()) {
        this.uploadBody = nsDataToUtf8OrBase64(new ObjC.Object(bodyArg));
      }
    } catch (_) {
      this.uploadBody = null;
    }
  },
  onLeave(retval) {
    try {
      if (this.uploadBody) {
        uploadBodyByTaskPtr[retval.toString()] = this.uploadBody;
      }
    } catch (_) {
      // Ignore best-effort cache failures.
    }
  },
});

send({ type: "ready", message: "NSURLSession request hooks installed" });
