package com.gx.capture.runtime.client;

import java.io.IOException;
import java.io.InputStream;
import java.util.List;
import java.util.Map;

/** Transport seam used by the HTTP client and deterministic tests. */
public interface RuntimeTransport {
  RuntimeResponse request(RuntimeRequest request) throws IOException, InterruptedException;

  /** A response whose body can be consumed incrementally by an SSE reader. */
  default RuntimeResponse stream(RuntimeRequest request) throws IOException, InterruptedException {
    return request(request);
  }

  record RuntimeRequest(
      String method, String path, Map<String, List<String>> headers, byte[] body) {
    public RuntimeRequest {
      method = method == null || method.isBlank() ? "GET" : method.strip().toUpperCase();
      path = path == null || path.isBlank() ? "/" : path;
      headers = headers == null ? Map.of() : Map.copyOf(headers);
      body = body == null ? new byte[0] : body.clone();
    }

    public RuntimeRequest(String method, String path) {
      this(method, path, Map.of(), new byte[0]);
    }
  }

  record RuntimeResponse(int status, Map<String, List<String>> headers, byte[] body) {
    public RuntimeResponse {
      if (status < 100 || status > 599) {
        throw new IllegalArgumentException("HTTP status must be between 100 and 599");
      }
      headers = headers == null ? Map.of() : Map.copyOf(headers);
      body = body == null ? new byte[0] : body.clone();
    }

    public String header(String name) {
      if (name == null) return null;
      return headers.entrySet().stream()
          .filter(entry -> entry.getKey().equalsIgnoreCase(name))
          .flatMap(entry -> entry.getValue().stream())
          .findFirst()
          .orElse(null);
    }

    public InputStream bodyStream() {
      return new java.io.ByteArrayInputStream(body);
    }

    public boolean successful() {
      return status >= 200 && status < 300;
    }
  }
}
