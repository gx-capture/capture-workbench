package com.gx.capture.runtime.client;

/** Malformed, unexpected, or non-strictly-decodable runtime data. */
public class CaptureProtocolError extends CaptureRuntimeError {
  public CaptureProtocolError(String message) { this(message, null); }
  public CaptureProtocolError(String message, Throwable cause) {
    super(message, null, null, "protocol", false, null, null, null, cause);
  }
}
