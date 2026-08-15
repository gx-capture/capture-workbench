package com.gx.capture.runtime.client;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import java.io.IOException;

/** Package-private wire codecs. Generated/schema details never cross the public SDK boundary. */
final class WireCodecs {
  private WireCodecs() {}

  static ObjectMapper mapper() {
    return JsonMapper.builder()
        .addModule(new JavaTimeModule())
        .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
        .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
        .enable(DeserializationFeature.FAIL_ON_NULL_FOR_PRIMITIVES)
        .enable(DeserializationFeature.FAIL_ON_NUMBERS_FOR_ENUMS)
        .build();
  }

  static byte[] encode(Object value, ObjectMapper mapper) {
    try {
      return mapper.writeValueAsBytes(value);
    } catch (IOException error) {
      throw new CaptureProtocolError("Capture Runtime request could not be encoded", error);
    }
  }

  static <T> T decode(byte[] body, Class<T> type, ObjectMapper mapper) {
    try {
      return mapper.readValue(body, type);
    } catch (IOException | IllegalArgumentException error) {
      throw new CaptureProtocolError(
          "Capture Runtime response failed strict decoding for " + type.getSimpleName(), error);
    }
  }

  static JsonNode node(byte[] body, ObjectMapper mapper) {
    try {
      var value = mapper.readTree(body);
      if (value == null || !value.isObject()) {
        throw new CaptureProtocolError("Capture Runtime returned a non-object JSON payload");
      }
      return value;
    } catch (CaptureProtocolError error) {
      throw error;
    } catch (IOException error) {
      throw new CaptureProtocolError("Capture Runtime returned invalid JSON", error);
    }
  }
}
