package com.gx.capture.runtime.client;

/** Transport failures that occurred before a remote response was received. */
public class CaptureTransportError extends CaptureRuntimeError {
  public CaptureTransportError(String message, Throwable cause) {
    super(message, null, null, "transport", false, null, null, null, cause);
  }
}
