package com.gx.capture.runtime.client;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.lang.reflect.Modifier;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

class CaptureRuntimeClientTest {
  private static final ObjectMapper MAPPER = WireCodecs.mapper();

  @Test
  void generatedWireModelsArePrivateAndPublicSeamIsV2Typed() {
    assertThat(Modifier.isPublic(CaptureRuntimeTypes.class.getModifiers())).isTrue();
    assertThat(Modifier.isPublic(WireCodecs.class.getModifiers())).isFalse();
    for (Class<?> nested : CaptureRuntimeTypes.class.getDeclaredClasses()) {
      assertThat(Modifier.isPublic(nested.getModifiers())).isTrue();
    }
  }

  @Test
  void discoversOnlyTheImmutableV2BundleAndPinsItsDigest() throws Exception {
    var bundle = bundle();
    var digest = CaptureRuntimeClientTest.sha256(bundle);
    var index =
        MAPPER.writeValueAsBytes(
            Map.of(
                "catalogVersion",
                "2",
                "runtimeVersion",
                "0.4.0",
                "contractSetVersion",
                "2",
                "surfaces",
                List.of(Map.of("id", "v2")),
                "sha256",
                digest,
                "href",
                "/meta/v2/contracts/sha256/" + digest,
                "mediaType",
                "application/json"));
    var transport = metadataTransport(index, bundle);

    var discovery = new CaptureRuntimeClient(transport, options()).discover();

    assertThat(discovery.sha256()).isEqualTo(digest);
    assertThat(discovery.index().path("catalogVersion").asText()).isEqualTo("2");
    assertThat(discovery.bundle().path("operations").get(0).path("path").asText())
        .startsWith("/v2/");
  }

  @Test
  void rejectsUnknownOrTamperedContractIdentityBeforeAnyOperation() throws Exception {
    var bundle = bundle();
    var wrongDigest = "0".repeat(64);
    var index =
        MAPPER.writeValueAsBytes(
            Map.of(
                "catalogVersion",
                "2",
                "runtimeVersion",
                "0.4.0",
                "contractSetVersion",
                "2",
                "surfaces",
                List.of(Map.of("id", "v2")),
                "sha256",
                wrongDigest,
                "href",
                "/meta/v2/contracts/sha256/" + wrongDigest));
    var transport = metadataTransport(index, bundle);
    assertThatThrownBy(() -> new CaptureRuntimeClient(transport, options()).discover())
        .isInstanceOf(CaptureCompatibilityError.class);
  }

  @Test
  void unknownRemoteCodesRemainTypedWithoutLeakingDetails() {
    var error =
        CaptureRuntimeError.fromResponse(
            503,
            "{\"error\":{\"code\":\"future_problem\",\"message\":\"Try again\",\"category\":\"capacity\",\"retryable\":true,\"requestId\":\"req-1\",\"details\":{\"authorization\":\"Bearer hidden\"},\"issues\":[{\"field\":\"model\"}]}}"
                .getBytes(StandardCharsets.UTF_8),
            MAPPER);
    assertThat(error).isInstanceOf(CaptureRemoteError.class);
    assertThat(error.code()).isEqualTo("future_problem");
    assertThat(error.retryable()).isTrue();
    assertThat(error.requestId()).isEqualTo("req-1");
    assertThat(error.toString()).doesNotContain("hidden");
  }

  @Test
  void sseResumePreservesLastEventIdAndStopsAtTerminal() throws Exception {
    var bundle = bundle();
    var digest = sha256(bundle);
    var index = index(digest);
    var observedLastEventId = new java.util.concurrent.atomic.AtomicReference<String>();
    var routes = new ArrayList<InMemoryRuntimeTransport.Route>(metadataRoutes(index, bundle));
    routes.add(
        InMemoryRuntimeTransport.route(
            "GET",
            "/v2/captures/capture-1/events",
            request -> {
              observedLastEventId.set(request.headers().get("Last-Event-ID").getFirst());
              var body =
                  "id: 2\n"
                      + "event: completed\n"
                      + "data: {\"protocolVersion\":\"2\",\"eventId\":\"capture-1/2\",\"sequence\":2,\"captureId\":\"capture-1\",\"kind\":\"pdf\",\"eventType\":\"completed\",\"stage\":\"completed\",\"segments\":[],\"createdAt\":\"2026-08-14T00:00:00Z\"}\n\n";
              return response(200, "text/event-stream", body.getBytes(StandardCharsets.UTF_8));
            }));
    var events = new CaptureRuntimeClient(new InMemoryRuntimeTransport(routes), options()).captureEvents("capture-1", 1L);
    assertThat(events).hasSize(1);
    assertThat(events.getFirst().eventType()).isEqualTo(CaptureRuntimeTypes.EventType.COMPLETED);
    assertThat(observedLastEventId).hasValue("1");
  }

  @Test
  void retriesIdempotentRuntimeRequirementRequestOnce() throws Exception {
    var bundle = bundle();
    var digest = sha256(bundle);
    var index = index(digest);
    var attempts = new AtomicInteger();
    var routes = new ArrayList<InMemoryRuntimeTransport.Route>(metadataRoutes(index, bundle));
    routes.add(
        InMemoryRuntimeTransport.route(
            "GET",
            "/v2/runtime/requirements",
            request ->
                attempts.incrementAndGet() == 1
                    ? response(503, "application/json", "{}".getBytes(StandardCharsets.UTF_8))
                    : response(200, "application/json", "{\"items\":[]}".getBytes(StandardCharsets.UTF_8))));
    assertThat(new CaptureRuntimeClient(new InMemoryRuntimeTransport(routes), options()).getRequirements())
        .isEmpty();
    assertThat(attempts).hasValue(2);
  }

  @Test
  void strictDecodingRejectsUnknownEventFields() throws Exception {
    var bundle = bundle();
    var routes = metadataRoutes(index(sha256(bundle)), bundle);
    var transport = new InMemoryRuntimeTransport(routes);
    new CaptureRuntimeClient(transport, options()).discover();
    assertThatThrownBy(
            () ->
                WireCodecs.decode(
                    "{\"protocolVersion\":\"2\",\"eventId\":\"c/0\",\"sequence\":0,\"captureId\":\"c\",\"kind\":\"pdf\",\"eventType\":\"accepted\",\"stage\":\"created\",\"segments\":[],\"createdAt\":\"2026-08-14T00:00:00Z\",\"unexpected\":true}"
                        .getBytes(StandardCharsets.UTF_8),
                    CaptureRuntimeTypes.CaptureEvent.class,
                    MAPPER))
        .isInstanceOf(CaptureProtocolError.class);
  }

  @Test
  void decodesCanonicalRuntimeAndModelInstallationPayloads() {
    var runtime =
        WireCodecs.decode(
            "{\"installationId\":\"runtime-1\",\"requirementId\":\"windowsml-ocr\",\"status\":\"running\",\"progress\":0.5,\"error\":null,\"createdAt\":\"2026-08-14T00:00:00Z\",\"updatedAt\":\"2026-08-14T00:01:00Z\",\"completedAt\":null}"
                .getBytes(StandardCharsets.UTF_8),
            CaptureRuntimeTypes.RuntimeInstallation.class,
            MAPPER);
    assertThat(runtime.installationId()).isEqualTo("runtime-1");
    assertThat(runtime.requirementId()).isEqualTo("windowsml-ocr");
    assertThat(runtime.updatedAt()).isEqualTo("2026-08-14T00:01:00Z");

    var model =
        WireCodecs.decode(
            "{\"installationId\":\"model-1\",\"optionId\":\"qwen\",\"status\":\"completed\",\"progress\":1.0,\"error\":null,\"createdAt\":\"2026-08-14T00:00:00Z\",\"updatedAt\":\"2026-08-14T00:02:00Z\",\"completedAt\":\"2026-08-14T00:02:00Z\"}"
                .getBytes(StandardCharsets.UTF_8),
            CaptureRuntimeTypes.RuntimeModelInstallation.class,
            MAPPER);
    assertThat(model.installationId()).isEqualTo("model-1");
    assertThat(model.optionId()).isEqualTo("qwen");
    assertThat(model.completedAt()).isEqualTo("2026-08-14T00:02:00Z");
  }

  private static CaptureRuntimeClient.ClientOptions options() {
    try {
      return new CaptureRuntimeClient.ClientOptions("2", Set.of(sha256(bundle())), 1);
    } catch (Exception error) {
      throw new AssertionError(error);
    }
  }

  private static InMemoryRuntimeTransport metadataTransport(byte[] index, byte[] bundle) {
    return new InMemoryRuntimeTransport(metadataRoutes(index, bundle));
  }

  private static List<InMemoryRuntimeTransport.Route> metadataRoutes(byte[] index, byte[] bundle) {
    var routes =
        new ArrayList<InMemoryRuntimeTransport.Route>();
    routes.add(InMemoryRuntimeTransport.route("GET", "/meta/v2/contracts", ignored -> response(200, "application/json", index)));
    routes.add(InMemoryRuntimeTransport.route("GET", Pattern.compile("/meta/v2/contracts/sha256/.*"), ignored -> response(200, "application/json", bundle)));
    routes.add(InMemoryRuntimeTransport.route("GET", "/v2/health/ready", ignored -> response(200, "application/json", "{\"ready\":true,\"service\":\"capture-runtime\",\"apiVersion\":\"2.0\",\"runtimeVersion\":\"0.4.0\",\"captureDocumentSchemaVersion\":\"2\",\"captureDocumentSchemaSha256\":null,\"schemaSha256\":null,\"contractSetVersion\":\"2\",\"capabilities\":{}}".getBytes(StandardCharsets.UTF_8))));
    routes.add(InMemoryRuntimeTransport.route("GET", "/v2/streaming/health/ready", ignored -> response(200, "application/json", "{\"protocolVersion\":\"2\",\"captureKinds\":[\"pdf\"],\"supportsProgressiveAudio\":true,\"maxChunkBytes\":2,\"checkpointIntervalMs\":1000,\"heartbeatIntervalMs\":1000,\"stallTimeoutMs\":10000}".getBytes(StandardCharsets.UTF_8))));
    return routes;
  }

  private static byte[] bundle() throws Exception {
    return MAPPER.writeValueAsBytes(
        Map.of(
            "contractSetVersion", "2",
            "schemaDialect", "https://json-schema.org/draft/2020-12/schema",
            "surfaces", List.of(Map.of("id", "v2")),
            "schemas", List.of(),
            "operations", List.of(
                operation("/v2/health/ready"),
                operation("/v2/streaming/health/ready"),
                operation("/v2/runtime/requirements"),
                operation("/v2/runtime/installations"),
                operation("/v2/captures"),
                operation("/v2/captures/{capture_id}/events"),
                operation("/v2/captures/{capture_id}/raw"),
                operation("/v2/captures/{capture_id}/result")),
            "problems", List.of(),
            "invariants", List.of()));
  }

  private static Map<String, Object> operation(String path) {
    return Map.of(
        "id", path,
        "path", path,
        "method", "GET",
        "surface", "v2",
        "body", Map.of("kind", "none"),
        "requiredHeaders", List.of(),
        "idempotency", Map.of("mode", "none"),
        "responseStatusCodes", List.of(200));
  }

  private static byte[] index(String digest) throws Exception {
    return MAPPER.writeValueAsBytes(Map.of("catalogVersion", "2", "runtimeVersion", "0.4.0", "contractSetVersion", "2", "surfaces", List.of(Map.of("id", "v2")), "sha256", digest, "href", "/meta/v2/contracts/sha256/" + digest, "mediaType", "application/json"));
  }

  private static RuntimeTransport.RuntimeResponse response(int status, String contentType, byte[] body) {
    return new RuntimeTransport.RuntimeResponse(status, Map.of("Content-Type", List.of(contentType)), body);
  }

  private static String sha256(byte[] bytes) {
    try {
      return java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));
    } catch (Exception error) {
      throw new AssertionError(error);
    }
  }
}
