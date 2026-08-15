package com.gx.capture.runtime.client;

/** Contract identity or capability negotiation failures. */
public class CaptureCompatibilityError extends CaptureRuntimeError {
  public CaptureCompatibilityError(String message) {
    super(message, null, null, "compatibility", false, null, null, null, null);
  }
}
