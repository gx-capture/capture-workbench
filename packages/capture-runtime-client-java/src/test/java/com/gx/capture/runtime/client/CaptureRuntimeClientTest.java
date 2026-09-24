package com.gx.capture.runtime.client;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.lang.reflect.Modifier;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
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
                "0.4.2",
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
                "0.4.2",
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

    var missingBoxConfidenceJson =
        new String(ocrJson("completed", "recognized"), StandardCharsets.UTF_8)
            .replace(
                "\"text\":\"OCR text\",\"confidence\":0.9}],\"confidence\":0.9",
                "\"text\":\"OCR text\"}],\"confidence\":0.9");
    assertThatThrownBy(
            () ->
                WireCodecs.decode(
                    missingBoxConfidenceJson.getBytes(StandardCharsets.UTF_8),
                    CaptureRuntimeTypes.CaptureOcrProjection.class,
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

  @Test
  void decodesCanonicalPageLevelOcrProjection() {
    var projection =
        WireCodecs.decode(
            ocrJson("completed", "recognized"),
            CaptureRuntimeTypes.CaptureOcrProjection.class,
            MAPPER);
    assertThat(projection.status()).isEqualTo(CaptureRuntimeTypes.OcrProjectionStatus.COMPLETED);
    assertThat(projection.pages()).hasSize(1);
    var box = projection.pages().getFirst().boxes().getFirst();
    assertThat(box.polygon()).hasSize(4);
    assertThat(box.polygon().get(0).x()).isEqualTo(2.5);
    assertThat(box.polygon().get(0).y()).isEqualTo(3.5);
    assertThat(box.polygon().get(1).x()).isEqualTo(22.5);
    assertThat(box.polygon().get(1).y()).isEqualTo(2.5);
    assertThat(box.polygon().get(2).x()).isEqualTo(24.5);
    assertThat(box.polygon().get(2).y()).isEqualTo(13.5);
    assertThat(box.polygon().get(3).x()).isEqualTo(3.5);
    assertThat(box.polygon().get(3).y()).isEqualTo(15.5);
    assertThat(box.text()).isEqualTo("OCR text");
    assertThat(box.confidence()).isEqualTo(0.9);
  }

  @Test
  void serializesCanonicalPolygonWithoutLossyRectangleFields() throws Exception {
    var projection =
        WireCodecs.decode(
            ocrJson("completed", "recognized"),
            CaptureRuntimeTypes.CaptureOcrProjection.class,
            MAPPER);
    var encoded = MAPPER.writeValueAsString(projection);
    assertThat(encoded)
        .contains("\"boxes\":[{\"polygon\"")
        .doesNotContain("\"width\":20")
        .doesNotContain("\"height\":10");
    assertThat(encoded).contains("\"text\":\"OCR text\"");
  }

  @Test
  void preservesPerspectivePolygonOrderAndRejectsRectangleOnlyPayloads() {
    var rectangleOnlyJson =
        new String(ocrJson("completed", "recognized"), StandardCharsets.UTF_8)
            .replace(
                "\"polygon\":[{\"x\":2.5,\"y\":3.5},{\"x\":22.5,\"y\":2.5},{\"x\":24.5,\"y\":13.5},{\"x\":3.5,\"y\":15.5}],\"text\":\"OCR text\",\"confidence\":0.9",
                "\"x\":2,\"y\":3,\"width\":20,\"height\":10");
    assertThatThrownBy(
            () ->
                WireCodecs.decode(
                    rectangleOnlyJson.getBytes(StandardCharsets.UTF_8),
                    CaptureRuntimeTypes.CaptureOcrProjection.class,
                    MAPPER))
        .isInstanceOf(CaptureProtocolError.class);
  }

  @Test
  void wireDecodingRejectsNonCanonicalReferencedSourceAndFailureValues() throws Exception {
    var uppercaseSource = (ObjectNode) MAPPER.readTree(ocrJson("completed", "recognized"));
    uppercaseSource.with("source").put("sha256", "A".repeat(64));
    assertThatThrownBy(
            () ->
                WireCodecs.decode(
                    MAPPER.writeValueAsBytes(uppercaseSource),
                    CaptureRuntimeTypes.CaptureOcrProjection.class,
                    MAPPER))
        .isInstanceOf(CaptureProtocolError.class);

    var uppercaseFailure = (ObjectNode) MAPPER.readTree(ocrJson("failed", "empty"));
    uppercaseFailure.with("failure").put("code", "OCR_FAILED");
    assertThatThrownBy(
            ()
                ->
                    WireCodecs.decode(
                        MAPPER.writeValueAsBytes(uppercaseFailure),
                        CaptureRuntimeTypes.CaptureOcrProjection.class,
                        MAPPER))
        .isInstanceOf(CaptureProtocolError.class);
  }

  @Test
  void sharesReferencedInvalidCorpusRejectionsWithTypeScriptAndPythonValidators() throws Exception {
    var corpus =
        MAPPER.readTree(
                Files.readString(
                    Path.of(
                        "..",
                        "capture-runtime",
                        "tests",
                        "fixtures",
                        "ocr-projection-v3-referenced-invalid-corpus.json")))
            .path("cases");
    assertThat(corpus).hasSize(12);
    for (var invalid : corpus) {
      var payload =
          (ObjectNode)
              MAPPER.readTree(
                  "completed".equals(invalid.path("base").asText())
                      ? ocrJson("completed", "recognized")
                      : ocrJson("failed", "empty"));
      applyCorpusMutation(payload, invalid);
      assertThatThrownBy(
              () ->
                  WireCodecs.decode(
                      MAPPER.writeValueAsBytes(payload),
                      CaptureRuntimeTypes.CaptureOcrProjection.class,
                      MAPPER))
          .as(invalid.path("name").asText())
          .isInstanceOf(CaptureProtocolError.class);
    }
  }

  @Test
  void keepsDirectReferencedDtoConstructionCompatibleWhileWireDecodingIsStrict() {
    assertThat(
            new CaptureRuntimeTypes.Source(
                    "A".repeat(64), "scan.pdf", "application/pdf", 10)
                .sha256())
        .isEqualTo("a".repeat(64));
    assertThat(
            new CaptureRuntimeTypes.Failure("OCR_FAILED", "OCR failed", "ocr", false).code())
        .isEqualTo("ocr_failed");
  }

  @Test
  void exposesTheCanonicalOptionalPdfPagePrefixAndPreservesLegacyStartConstruction()
      throws Exception {
    var selected =
        new CaptureRuntimeTypes.StartCapture(
            "2",
            "request-1",
            "ingestion-1",
            CaptureRuntimeTypes.StructuringMode.RUNTIME,
            null,
            "eager",
            List.of(1, 2));
    assertThat(selected.pdfPageNumbers()).containsExactly(1, 2);
    assertThat(MAPPER.readTree(MAPPER.writeValueAsBytes(selected)).path("pdfPageNumbers")).isEqualTo(
        MAPPER.readTree("[1,2]"));

    var legacy =
        new CaptureRuntimeTypes.StartCapture(
            "2",
            "request-1",
            "ingestion-1",
            CaptureRuntimeTypes.StructuringMode.RUNTIME,
            null,
            "eager");
    assertThat(legacy.pdfPageNumbers()).isNull();
    assertThat(CaptureRuntimeTypes.CONTRACT_SET_SHA256)
        .isEqualTo("d293a3de26114f1b4fd65ea6d6d3f157fa2f93109b31e1e30d5d15ef0dfdeb40");

    assertThatThrownBy(
            () ->
                new CaptureRuntimeTypes.StartCapture(
                    "2",
                    "request-1",
                    "ingestion-1",
                    CaptureRuntimeTypes.StructuringMode.RUNTIME,
                    null,
                    "eager",
                    List.of(2)))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("ordered prefix");
  }

  @Test
  void forwardsTheOptionalPdfPagePrefixThroughTheStreamingStartOperation() throws Exception {
    var bundle = bundle();
    var index = index(sha256(bundle));
    var observedStart = new java.util.concurrent.atomic.AtomicReference<JsonNode>();
    var routes = new ArrayList<InMemoryRuntimeTransport.Route>(metadataRoutes(index, bundle));
    routes.add(
        InMemoryRuntimeTransport.route(
            "POST",
            "/v2/ingestions",
            ignored -> response(201, "application/json", ingestionJson("open", 0, 0, 0, 0, null))));
    routes.add(
        InMemoryRuntimeTransport.route(
            "PUT",
            "/v2/ingestions/ingestion-1/chunks/0",
            ignored ->
                response(200, "application/json", ingestionJson("open", 2, 2, 1, 2, null))));
    routes.add(
        InMemoryRuntimeTransport.route(
            "PUT",
            "/v2/ingestions/ingestion-1/chunks/1",
            ignored ->
                response(200, "application/json", ingestionJson("open", 3, 3, 2, 3, null))));
    routes.add(
        InMemoryRuntimeTransport.route(
            "POST",
            "/v2/ingestions/ingestion-1/finalize",
            ignored ->
                response(
                    200,
                    "application/json",
                    ingestionJson("ready", 3, 3, 1, 3, sha256("abc".getBytes(StandardCharsets.UTF_8))))));
    routes.add(
        InMemoryRuntimeTransport.route(
            "POST",
            "/v2/captures",
            request -> {
              try {
                observedStart.set(MAPPER.readTree(request.body()));
              } catch (Exception error) {
                throw new AssertionError(error);
              }
              return response(202, "application/json", captureOperationJson());
            }));

    var operation =
        new CaptureRuntimeClient(new InMemoryRuntimeTransport(routes), options())
            .startStreamingCapture(
                new CaptureRuntimeClient.CaptureUpload(
                    "scan.pdf",
                    "abc".getBytes(StandardCharsets.UTF_8),
                    "application/pdf",
                    CaptureRuntimeTypes.SourceKind.PDF,
                    null,
                    CaptureRuntimeTypes.StructuringMode.RUNTIME,
                    "request-1",
                    List.of(1)));

    assertThat(operation.captureId()).isEqualTo("capture-1");
    assertThat(observedStart)
        .hasValueSatisfying(
            body -> assertThat(body.path("pdfPageNumbers").toString()).isEqualTo("[1]"));
  }

  @Test
  void decodesCanonicalRawCapturePageScopeEvidence() {
    var source = new CaptureRuntimeTypes.Source("a".repeat(64), "scan.pdf", "application/pdf", 10);
    var engine = new CaptureRuntimeTypes.Engine("windowsml-ocr", "paddle", "sha256:" + "b".repeat(64), "cpu");
    var segment =
        new CaptureRuntimeTypes.RawCaptureSegment(
            "segment-1", 0, new CaptureRuntimeTypes.PageLocator(1, null), "one");
    var raw =
        new CaptureRuntimeTypes.RawCapture(
            "2",
            true,
            source,
            List.of(segment),
            "one",
            engine,
            List.of(),
            "2026-08-14T00:00:00Z",
            new CaptureRuntimeTypes.OcrPageScope(46, List.of(1), List.of(1)));

    var decoded =
        WireCodecs.decode(
            WireCodecs.encode(raw, MAPPER), CaptureRuntimeTypes.RawCapture.class, MAPPER);
    assertThat(decoded.ocrPageScope().sourcePageCount()).isEqualTo(46);
    assertThat(decoded.ocrPageScope().requestedPageNumbers()).containsExactly(1);
    assertThat(decoded.ocrPageScope().processedPageNumbers()).containsExactly(1);
  }

  @Test
  void sharesTheCanonicalPerspectiveCorpusWithTypeScriptAndPythonValidators() throws Exception {
    var perspective = sharedPerspectiveOcrJson();
    var decoded =
        WireCodecs.decode(
            perspective, CaptureRuntimeTypes.CaptureOcrProjection.class, MAPPER);
    assertThat(decoded.pages().getFirst().boxes().getFirst().polygon())
        .extracting(CaptureRuntimeTypes.OcrPoint::x)
        .containsExactly(11.25, 91.75, 104.0, 4.5);

    var rectangle = (ObjectNode) MAPPER.readTree(perspective);
    ((ObjectNode) rectangle.withArray("pages").get(0).withArray("boxes").get(0))
        .remove("polygon");
    ((ObjectNode) rectangle.withArray("pages").get(0).withArray("boxes").get(0))
        .put("x", 4)
        .put("y", 18)
        .put("width", 100)
        .put("height", 46);
    assertThatThrownBy(
            () ->
                WireCodecs.decode(
                    MAPPER.writeValueAsBytes(rectangle),
                    CaptureRuntimeTypes.CaptureOcrProjection.class,
                    MAPPER))
        .isInstanceOf(CaptureProtocolError.class);

    var nonFinite = (ObjectNode) MAPPER.readTree(perspective);
    ((ObjectNode)
            nonFinite.withArray("pages").get(0).withArray("boxes").get(0).withArray("polygon").get(0))
        .put("x", Double.NaN);
    assertThatThrownBy(
            () ->
                WireCodecs.decode(
                    MAPPER.writeValueAsBytes(nonFinite),
                    CaptureRuntimeTypes.CaptureOcrProjection.class,
                    MAPPER))
        .isInstanceOf(CaptureProtocolError.class);

    var outOfBounds = (ObjectNode) MAPPER.readTree(perspective);
    ((ObjectNode)
            outOfBounds
                .withArray("pages")
                .get(0)
                .withArray("boxes")
                .get(0)
                .withArray("polygon")
                .get(0))
        .put("x", 121);
    assertThatThrownBy(
            () ->
                WireCodecs.decode(
                    MAPPER.writeValueAsBytes(outOfBounds),
                    CaptureRuntimeTypes.CaptureOcrProjection.class,
                    MAPPER))
        .isInstanceOf(CaptureProtocolError.class);
  }

  @Test
  void decodesFailedProjectionWithUnavailableProvenanceWithoutFakeIdentity() {
    var projection =
        WireCodecs.decode(
            unavailableOcrJson(), CaptureRuntimeTypes.CaptureOcrProjection.class, MAPPER);
    assertThat(projection.status()).isEqualTo(CaptureRuntimeTypes.OcrProjectionStatus.FAILED);
    assertThat(projection.provenance())
        .isInstanceOf(CaptureRuntimeTypes.OcrProvenanceUnavailable.class);
    var unavailable =
        (CaptureRuntimeTypes.OcrProvenanceUnavailable) projection.provenance();
    assertThat(unavailable.status()).isEqualTo("unavailable");
    assertThat(unavailable.reason())
        .isEqualTo(CaptureRuntimeTypes.OcrProvenanceUnavailableReason.MODEL_UNAVAILABLE);
  }

  @Test
  void getOcrUsesTheTypedPageProjectionForCompletedAndFailedResponses() throws Exception {
    var bundle = bundle();
    var index = index(sha256(bundle));
    var routes = new ArrayList<InMemoryRuntimeTransport.Route>(metadataRoutes(index, bundle));
    routes.add(
        InMemoryRuntimeTransport.route(
            "GET",
            "/v2/captures/cap/ocr",
            ignored -> response(200, "application/json", ocrJson("completed", "recognized"))));
    var completed =
        new CaptureRuntimeClient(new InMemoryRuntimeTransport(routes), options()).getOcr("cap");
    assertThat(completed.status()).isEqualTo(CaptureRuntimeTypes.OcrProjectionStatus.COMPLETED);
    assertThat(completed.pages()).hasSize(1);

    routes = new ArrayList<InMemoryRuntimeTransport.Route>(metadataRoutes(index, bundle));
    routes.add(
        InMemoryRuntimeTransport.route(
            "GET",
            "/v2/captures/cap/ocr",
            ignored -> response(200, "application/json", ocrJson("failed", "empty"))));
    var failed =
        new CaptureRuntimeClient(new InMemoryRuntimeTransport(routes), options()).getOcr("cap");
    assertThat(failed.status()).isEqualTo(CaptureRuntimeTypes.OcrProjectionStatus.FAILED);
    assertThat(failed.failure()).isNotNull();
  }

  @Test
  void getOcrMapsAuthenticationNotFoundAndConflictToTypedErrors() throws Exception {
    var bundle = bundle();
    var index = index(sha256(bundle));
    for (var status : List.of(401, 404, 409)) {
      var routes = new ArrayList<InMemoryRuntimeTransport.Route>(metadataRoutes(index, bundle));
      routes.add(
          InMemoryRuntimeTransport.route(
              "GET",
              "/v2/captures/cap/ocr",
              ignored -> response(status, "application/json", errorJson(status))));
      var client = new CaptureRuntimeClient(new InMemoryRuntimeTransport(routes), options());
      assertThatThrownBy(() -> client.getOcr("cap"))
          .satisfies(
              error -> {
                assertThat(error).isInstanceOf(CaptureRuntimeError.class);
                var runtimeError = (CaptureRuntimeError) error;
                assertThat(runtimeError.status()).isEqualTo(status);
                assertThat(runtimeError.code())
                    .isEqualTo(status == 401 ? "unauthorized" : "ocr_unavailable");
                if (status == 401) assertThat(error).isInstanceOf(CaptureAuthenticationError.class);
                else assertThat(error).isInstanceOf(CaptureRemoteError.class);
              });
    }
  }

  @Test
  void completedOcrRejectsFailedPagesAndMismatchedDocumentProvenance() {
    var source = new CaptureRuntimeTypes.Source("a".repeat(64), "scan.pdf", "application/pdf", 10);
    var pageEngine = ocrEngine("b");
    var documentEngine = ocrEngine("c");
    var raster = new CaptureRuntimeTypes.OcrRaster(100, 80, 2, "pixel");
    var failure = new CaptureRuntimeTypes.Failure("ocr_failed", "Page failed", "ocr", false);
    var unavailable =
        new CaptureRuntimeTypes.OcrProvenanceUnavailable(
            "unavailable",
            "capture-workbench-ocr-pipeline-v1",
            "c".repeat(64),
            CaptureRuntimeTypes.OcrProvenanceUnavailableReason.MODEL_UNAVAILABLE);
    assertThatThrownBy(
            () ->
                new CaptureRuntimeTypes.OcrPageProjection(
                    1,
                    CaptureRuntimeTypes.OcrPageStatus.RECOGNIZED,
                    raster,
                    "recognized",
                    List.of(),
                    0.9,
                    unavailable,
                    null))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("resolved provenance");
    var failedPage =
        new CaptureRuntimeTypes.OcrPageProjection(
            1,
            CaptureRuntimeTypes.OcrPageStatus.FAILED,
            raster,
            "",
            List.of(),
            null,
            pageEngine,
            failure);
    assertThatThrownBy(
            () ->
                new CaptureRuntimeTypes.CaptureOcrProjection(
                    "2.0",
                    "3",
                    "cap",
                    CaptureRuntimeTypes.OcrProjectionStatus.COMPLETED,
                    source,
                    List.of(failedPage),
                    1,
                    "0.4.2",
                    CaptureRuntimeTypes.CONTRACT_SET_SHA256,
                    pageEngine,
                    List.of(),
                    null,
                    "2026-08-14T00:00:00Z"))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("failed pages");

    var recognizedPage =
        new CaptureRuntimeTypes.OcrPageProjection(
            1,
            CaptureRuntimeTypes.OcrPageStatus.RECOGNIZED,
            raster,
            "繁中 OCR",
            List.of(
                new CaptureRuntimeTypes.OcrBox(
                    List.of(
                        new CaptureRuntimeTypes.OcrPoint(2.5, 3.5),
                        new CaptureRuntimeTypes.OcrPoint(22.5, 2.5),
                        new CaptureRuntimeTypes.OcrPoint(24.5, 13.5),
                        new CaptureRuntimeTypes.OcrPoint(3.5, 15.5)),
                    "recognized",
                    0.9)),
            0.9,
            pageEngine,
            null);
    var projectionWithRequiredIdentity =
        new CaptureRuntimeTypes.CaptureOcrProjection(
            "2.0",
            "3",
            "cap",
            CaptureRuntimeTypes.OcrProjectionStatus.COMPLETED,
            source,
            List.of(recognizedPage),
            1,
            "0.4.2",
            CaptureRuntimeTypes.CONTRACT_SET_SHA256,
            pageEngine,
            List.of(),
            null,
            "2026-08-14T00:00:00Z");
    assertThat(projectionWithRequiredIdentity.apiVersion()).isEqualTo("2.0");
    assertThat(projectionWithRequiredIdentity.schemaVersion()).isEqualTo("3");
    assertThatThrownBy(
            () ->
                new CaptureRuntimeTypes.CaptureOcrProjection(
                    null,
                    null,
                    "cap",
                    CaptureRuntimeTypes.OcrProjectionStatus.COMPLETED,
                    source,
                    List.of(recognizedPage),
                    1,
                    "0.4.2",
                    CaptureRuntimeTypes.CONTRACT_SET_SHA256,
                    pageEngine,
                    List.of(),
                    null,
                    "2026-08-14T00:00:00Z"))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(
            () ->
                new CaptureRuntimeTypes.CaptureOcrProjection(
                    "2.0",
                    "3",
                    "cap",
                    CaptureRuntimeTypes.OcrProjectionStatus.COMPLETED,
                    source,
                    List.of(recognizedPage),
                    1,
                    "0.4.2",
                    CaptureRuntimeTypes.CONTRACT_SET_SHA256,
                    documentEngine,
                    List.of(),
                    null,
                    "2026-08-14T00:00:00Z"))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("provenance");

    var emptyPage =
        new CaptureRuntimeTypes.OcrPageProjection(
            1,
            CaptureRuntimeTypes.OcrPageStatus.EMPTY,
            raster,
            "",
            List.of(),
            null,
            pageEngine,
            null);
    assertThatThrownBy(
            () ->
                new CaptureRuntimeTypes.CaptureOcrProjection(
                    "2.0",
                    "3",
                    "cap",
                    CaptureRuntimeTypes.OcrProjectionStatus.COMPLETED,
                    source,
                    List.of(emptyPage),
                    1,
                    "0.4.2",
                    CaptureRuntimeTypes.CONTRACT_SET_SHA256,
                    pageEngine,
                    List.of(),
                    null,
                    "2026-08-14T00:00:00Z"))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("recognized");

    assertThatThrownBy(
            () ->
                new CaptureRuntimeTypes.OcrPageProjection(
                    1,
                    CaptureRuntimeTypes.OcrPageStatus.RECOGNIZED,
                    raster,
                    "recognized",
                    List.of(),
                    0.9,
                    null,
                    null))
        .isInstanceOf(NullPointerException.class)
        .hasMessageContaining("provenance");
  }

  @Test
  void ocrValidationRetainsPageCompletenessAndRasterFailureSemantics() {
    var raster = new CaptureRuntimeTypes.OcrRaster(100, 80, 2, "pixel");
    var engine = ocrEngine("b");
    assertThatThrownBy(
            () ->
                new CaptureRuntimeTypes.OcrProvenanceResolved(
                    "resolved",
                    "windowsml-ocr",
                    "pp-ocrv6-medium-windowsml",
                    "sha256:" + "0".repeat(64),
                    "windowsml-dml",
                    "capture-workbench-ocr-pipeline-v1",
                    "b".repeat(64)))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("resolved model");
    assertThatThrownBy(() -> new CaptureRuntimeTypes.OcrRaster(100, 80, 2, null))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("coordinateSystem");
    assertThatThrownBy(
            () ->
                new CaptureRuntimeTypes.CaptureOcrProjection(
                    "2.0",
                    "3",
                    "cap",
                    CaptureRuntimeTypes.OcrProjectionStatus.FAILED,
                    null,
                    List.of(
                        new CaptureRuntimeTypes.OcrPageProjection(
                            2,
                            CaptureRuntimeTypes.OcrPageStatus.EMPTY,
                            raster,
                            "",
                            List.of(),
                            null,
                            engine,
                            null)),
                    1,
                    "0.4.2",
                    CaptureRuntimeTypes.CONTRACT_SET_SHA256,
                    engine,
                    List.of(),
                    new CaptureRuntimeTypes.Failure("ocr_failed", "Projection failed", "ocr", false),
                    "2026-08-14T00:00:00Z"))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("ordered");
    assertThatThrownBy(() -> new CaptureRuntimeTypes.OcrRaster(100, 80, 9, "pixel"))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> new CaptureRuntimeTypes.OcrPoint(-1, 0))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("finite and non-negative");
    assertThatThrownBy(() -> new CaptureRuntimeTypes.OcrPoint(Double.NaN, 0))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("finite and non-negative");
    assertThatThrownBy(
            () ->
                new CaptureRuntimeTypes.OcrBox(
                    List.of(
                        new CaptureRuntimeTypes.OcrPoint(1, 1),
                        new CaptureRuntimeTypes.OcrPoint(2, 1),
                        new CaptureRuntimeTypes.OcrPoint(2, 2)),
                    "recognized",
                    0.9))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("between 4 and 256");
    assertThatThrownBy(
            () ->
                new CaptureRuntimeTypes.OcrBox(
                    List.of(
                        new CaptureRuntimeTypes.OcrPoint(1, 1),
                        new CaptureRuntimeTypes.OcrPoint(2, 1),
                        new CaptureRuntimeTypes.OcrPoint(2, 2),
                        new CaptureRuntimeTypes.OcrPoint(1, 2)),
                    "",
                    null))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("text");
    assertThatThrownBy(
            () ->
                new CaptureRuntimeTypes.CaptureOcrProjection(
                    "2.0",
                    "3",
                    "cap",
                    CaptureRuntimeTypes.OcrProjectionStatus.FAILED,
                    null,
                    null,
                    0,
                    "0.4.2",
                    CaptureRuntimeTypes.CONTRACT_SET_SHA256,
                    engine,
                    List.of(),
                    new CaptureRuntimeTypes.Failure("ocr_failed", "Projection failed", "ocr", false),
                    "2026-08-14T00:00:00Z"))
        .isInstanceOf(NullPointerException.class)
        .hasMessageContaining("pages");
    assertThatThrownBy(
            () ->
                new CaptureRuntimeTypes.OcrPageProjection(
                    1,
                    CaptureRuntimeTypes.OcrPageStatus.RECOGNIZED,
                    raster,
                    "recognized",
                    List.of(
                        new CaptureRuntimeTypes.OcrBox(
                            List.of(
                                new CaptureRuntimeTypes.OcrPoint(90, 70),
                                new CaptureRuntimeTypes.OcrPoint(110, 70),
                                new CaptureRuntimeTypes.OcrPoint(110, 90),
                                new CaptureRuntimeTypes.OcrPoint(90, 90)),
                            "recognized",
                            0.9)),
                    0.9,
                    engine,
                    null))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(
            () ->
                new CaptureRuntimeTypes.OcrPageProjection(
                    1,
                    CaptureRuntimeTypes.OcrPageStatus.RECOGNIZED,
                    raster,
                    "",
                    List.of(),
                    0.9,
                    engine,
                    null))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(
            () ->
                new CaptureRuntimeTypes.OcrPageProjection(
                    1,
                    CaptureRuntimeTypes.OcrPageStatus.RECOGNIZED,
                    raster,
                    "recognized",
                    List.of(),
                    1.1,
                    engine,
                    null))
        .isInstanceOf(IllegalArgumentException.class);
  }

  private static byte[] sharedPerspectiveOcrJson() throws Exception {
    return Files.readString(
            Path.of(
                "..",
                "capture-runtime",
                "tests",
                "fixtures",
                "ocr-projection-v3-perspective.json"))
        .replace("__CONTRACT_SET_SHA256__", CaptureRuntimeTypes.CONTRACT_SET_SHA256)
        .getBytes(StandardCharsets.UTF_8);
  }

  private static void applyCorpusMutation(ObjectNode payload, JsonNode invalid) {
    var path = invalid.path("path");
    JsonNode parent = payload;
    for (var index = 0; index < path.size() - 1; index++) {
      parent = parent.path(path.get(index).asText());
    }
    var object = (ObjectNode) parent;
    var field = path.get(path.size() - 1).asText();
    if ("remove".equals(invalid.path("operation").asText())) {
      object.remove(field);
    } else {
      object.set(field, invalid.path("value").deepCopy());
    }
  }

  private static byte[] ocrJson(String projectionStatus, String pageStatus) {
    var completed = "completed".equals(projectionStatus);
    var source =
        completed
            ? "\"source\":{\"sha256\":\""
                + "a".repeat(64)
                + "\",\"fileName\":\"scan.pdf\",\"mediaType\":\"application/pdf\",\"bytes\":10},"
            : "\"source\":null,";
    var provenance =
        "\"provenance\":{\"status\":\"resolved\",\"engine\":\"windowsml-ocr\",\"model\":\"pp-ocrv6-medium-windowsml\",\"modelDigest\":\"sha256:"
            + "b".repeat(64)
            + "\",\"device\":\"windowsml-dml\",\"profileId\":\"capture-workbench-ocr-pipeline-v1\",\"profileSpecSha256\":\""
            + "c".repeat(64)
            + "\"},";
    var page =
        "recognized".equals(pageStatus)
            ? "\"page\":1,\"status\":\"recognized\",\"raster\":{\"width\":100,\"height\":80,\"scale\":2,\"coordinateSystem\":\"pixel\"},\"text\":\"OCR text\",\"boxes\":[{\"polygon\":[{\"x\":2.5,\"y\":3.5},{\"x\":22.5,\"y\":2.5},{\"x\":24.5,\"y\":13.5},{\"x\":3.5,\"y\":15.5}],\"text\":\"OCR text\",\"confidence\":0.9}],\"confidence\":0.9,\"provenance\":{\"status\":\"resolved\",\"engine\":\"windowsml-ocr\",\"model\":\"pp-ocrv6-medium-windowsml\",\"modelDigest\":\"sha256:"
                + "b".repeat(64)
                + "\",\"device\":\"windowsml-dml\",\"profileId\":\"capture-workbench-ocr-pipeline-v1\",\"profileSpecSha256\":\""
                + "c".repeat(64)
                + "\"},\"failure\":null"
            : "\"page\":1,\"status\":\"empty\",\"raster\":{\"width\":100,\"height\":80,\"scale\":2,\"coordinateSystem\":\"pixel\"},\"text\":\"\",\"boxes\":[],\"confidence\":null,\"provenance\":{\"status\":\"resolved\",\"engine\":\"windowsml-ocr\",\"model\":\"pp-ocrv6-medium-windowsml\",\"modelDigest\":\"sha256:"
                + "b".repeat(64)
                + "\",\"device\":\"windowsml-dml\",\"profileId\":\"capture-workbench-ocr-pipeline-v1\",\"profileSpecSha256\":\""
                + "c".repeat(64)
                + "\"},\"failure\":null";
    var failure =
        completed
            ? "\"failure\":null"
            : "\"failure\":{\"code\":\"ocr_failed\",\"message\":\"OCR failed\",\"stage\":\"ocr\",\"retryable\":false}";
    return ("{\"apiVersion\":\"2.0\",\"schemaVersion\":\"3\",\"captureId\":\"cap\",\"status\":\""
            + projectionStatus
            + "\","
            + source
            + "\"pages\":[{"
            + page
            + "}],"
            + "\"pageCount\":1,\"runtimeVersion\":\"0.4.2\",\"contractSha256\":\""
            + CaptureRuntimeTypes.CONTRACT_SET_SHA256
            + "\","
            + provenance
            + "\"warnings\":[],"
            + failure
            + ",\"createdAt\":\"2026-08-14T00:00:00Z\"}")
        .getBytes(StandardCharsets.UTF_8);
  }

  private static byte[] unavailableOcrJson() {
    return ("{\"apiVersion\":\"2.0\",\"schemaVersion\":\"3\",\"captureId\":\"cap\",\"status\":\"failed\","
            + "\"source\":null,\"pages\":[],\"pageCount\":0,\"runtimeVersion\":\"0.4.2\",\"contractSha256\":\""
            + CaptureRuntimeTypes.CONTRACT_SET_SHA256
            + "\",\"provenance\":{\"status\":\"unavailable\",\"profileId\":\"capture-workbench-ocr-pipeline-v1\",\"profileSpecSha256\":\""
            + "c".repeat(64)
            + "\",\"reason\":\"model_unavailable\"},\"warnings\":[],\"failure\":{\"code\":\"ocr_failed\",\"message\":\"OCR failed\",\"stage\":\"ocr\",\"retryable\":false},\"createdAt\":\"2026-08-14T00:00:00Z\"}")
        .getBytes(StandardCharsets.UTF_8);
  }

  private static byte[] errorJson(int status) {
    var code = status == 401 ? "unauthorized" : "ocr_unavailable";
    return ("{\"error\":{\"code\":\""
            + code
            + "\",\"message\":\"OCR unavailable\",\"category\":\"capture\",\"retryable\":false}}")
        .getBytes(StandardCharsets.UTF_8);
  }

  private static CaptureRuntimeTypes.OcrProvenance ocrEngine(String suffix) {
    return new CaptureRuntimeTypes.OcrProvenanceResolved(
        "resolved",
        "windowsml-ocr",
        "pp-ocrv6-medium-windowsml",
        "sha256:" + suffix.repeat(64),
        "windowsml-dml",
        "capture-workbench-ocr-pipeline-v1",
        "b".repeat(64));
  }

  @Test
  void opensPullsAndSubmitsTypedStructuringSessionBatches() throws Exception {
    var bundle = bundle();
    var index = index(sha256(bundle));
    var routes = new ArrayList<InMemoryRuntimeTransport.Route>(metadataRoutes(index, bundle));
    var observedKeys = new ArrayList<String>();
    routes.add(InMemoryRuntimeTransport.route("POST", "/v2/captures/cap/structure/session", request -> {
      observedKeys.add(request.headers().get("X-Idempotency-Key").getFirst());
      return response(201, "application/json", sessionJson(false));
    }));
    routes.add(InMemoryRuntimeTransport.route("GET", "/v2/captures/cap/structure/session", ignored -> response(200, "application/json", sessionJson(false))));
    routes.add(InMemoryRuntimeTransport.route("GET", "/v2/captures/cap/structure/session/batches/0", ignored -> response(200, "application/json", batchJson())));
    routes.add(InMemoryRuntimeTransport.route("PUT", "/v2/captures/cap/structure/session/batches/0", request -> {
      observedKeys.add(request.headers().get("X-Idempotency-Key").getFirst());
      return response(200, "application/json", sessionJson(true));
    }));

    var client = new CaptureRuntimeClient(new InMemoryRuntimeTransport(routes), options());
    var provider = new CaptureRuntimeTypes.StructuringProviderCapability(
        new CaptureRuntimeTypes.Engine("ollama", "qwen", "sha256:" + "a".repeat(64), null),
        "identity", "capture-structuring-v2");
    var request = new CaptureRuntimeTypes.OpenStructuringSession(
        "cap", provider, "capture-structuring-v2", "open-key", null, "2");
    assertThat(client.openStructuringSession("cap", request, "open-key").sessionId()).isEqualTo("session-1");
    assertThat(client.getStructuringSession("cap").status()).isEqualTo(CaptureRuntimeTypes.StructuringSessionStatus.OPEN);
    assertThat(client.pullStructuringBatch("cap", 0).batchDigest()).hasSize(64);
    var submission = new CaptureRuntimeTypes.SubmitStructuringBatch(
        "b".repeat(64),
        List.of(new CaptureRuntimeTypes.StructuringSemanticBlock("segment-1", CaptureRuntimeTypes.BlockType.PARAGRAPH, null)),
        "2");
    assertThat(client.submitStructuringBatch("cap", 0, submission, "batch-key").status())
        .isEqualTo(CaptureRuntimeTypes.StructuringSessionStatus.COMPLETED);
    assertThat(observedKeys).containsExactly("open-key", "batch-key");
  }

  private static byte[] sessionJson(boolean completed) {
    var status = completed ? "completed" : "open";
    var completedAt = completed ? "\"2026-08-14T00:02:00Z\"" : "null";
    return ("{\"protocolVersion\":\"2\",\"sessionId\":\"session-1\",\"captureId\":\"cap\","
        + "\"rawSourceSha256\":\"" + "a".repeat(64) + "\",\"contractSetSha256\":\"" + "b".repeat(64) + "\","
        + "\"providerCapability\":{\"provider\":{\"engine\":\"ollama\",\"model\":\"qwen\",\"digest\":\"sha256:"
        + "a".repeat(64) + "\",\"device\":null},\"capability\":\"identity\",\"schemaDialect\":\"capture-structuring-v2\"},"
        + "\"schemaDialect\":\"capture-structuring-v2\",\"batchCount\":1,\"nextBatchIndex\":"
        + (completed ? "1" : "0") + ",\"sessionDigest\":\"" + "c".repeat(64) + "\",\"status\":\"" + status
        + "\",\"targetLanguage\":null,\"createdAt\":\"2026-08-14T00:00:00Z\",\"updatedAt\":\"2026-08-14T00:02:00Z\",\"completedAt\":" + completedAt + "}")
        .getBytes(StandardCharsets.UTF_8);
  }

  private static byte[] batchJson() {
    return ("{\"protocolVersion\":\"2\",\"sessionId\":\"session-1\",\"captureId\":\"cap\",\"batchIndex\":0,\"batchCount\":1,"
        + "\"sourceSegmentIds\":[\"segment-1\"],\"providerPrompt\":{},\"providerSchema\":{},\"numCtx\":1024,\"numPredict\":128,"
        + "\"batchDigest\":\"" + "b".repeat(64) + "\",\"status\":\"ready\"}").getBytes(StandardCharsets.UTF_8);
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
    routes.add(InMemoryRuntimeTransport.route("GET", "/v2/health/ready", ignored -> response(200, "application/json", "{\"ready\":true,\"service\":\"capture-runtime\",\"apiVersion\":\"2.0\",\"runtimeVersion\":\"0.4.2\",\"captureDocumentSchemaVersion\":\"2\",\"captureDocumentSchemaSha256\":null,\"schemaSha256\":null,\"contractSetVersion\":\"2\",\"capabilities\":{}}".getBytes(StandardCharsets.UTF_8))));
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
                operation("/v2/captures/{capture_id}/ocr"),
                operation("/v2/captures/{capture_id}/result"),
                operation("/v2/captures/{capture_id}/structure/session", "POST", "json", "required"),
                operation("/v2/captures/{capture_id}/structure/session/batches/{batch_index}"),
                operation("/v2/captures/{capture_id}/structure/session/batches/{batch_index}", "PUT", "json", "required")),
            "problems", List.of(),
            "invariants", List.of()));
  }

  private static Map<String, Object> operation(String path) {
    return operation(path, "GET", "none", "none");
  }

  private static Map<String, Object> operation(String path, String method, String bodyKind, String idempotencyMode) {
    return Map.of(
        "id", path,
        "path", path,
        "method", method,
        "surface", "v2",
        "body", Map.of("kind", bodyKind),
        "requiredHeaders", "required".equals(idempotencyMode) ? List.of("X-Idempotency-Key") : List.of(),
        "idempotency", Map.of("mode", idempotencyMode),
        "responseStatusCodes", List.of(200));
  }

  private static byte[] index(String digest) throws Exception {
    return MAPPER.writeValueAsBytes(Map.of("catalogVersion", "2", "runtimeVersion", "0.4.2", "contractSetVersion", "2", "surfaces", List.of(Map.of("id", "v2")), "sha256", digest, "href", "/meta/v2/contracts/sha256/" + digest, "mediaType", "application/json"));
  }

  private static byte[] ingestionJson(
      String status,
      long receivedBytes,
      long contiguousBytes,
      long nextChunkIndex,
      long nextOffset,
      String finalizedSha256) {
    var finalized = finalizedSha256 == null ? "null" : "\"" + finalizedSha256 + "\"";
    return ("{\"protocolVersion\":\"2\",\"kind\":\"pdf\",\"ingestionId\":\"ingestion-1\","
            + "\"status\":\""
            + status
            + "\",\"fileName\":\"scan.pdf\",\"mediaType\":\"application/pdf\","
            + "\"totalBytes\":3,\"receivedBytes\":"
            + receivedBytes
            + ",\"contiguousBytes\":"
            + contiguousBytes
            + ",\"nextChunkIndex\":"
            + nextChunkIndex
            + ",\"nextOffset\":"
            + nextOffset
            + ",\"sourceSha256\":\""
            + "a".repeat(64)
            + "\",\"finalizedSha256\":"
            + finalized
            + ",\"expiresAt\":\"2026-08-14T00:00:00Z\"}")
        .getBytes(StandardCharsets.UTF_8);
  }

  private static byte[] captureOperationJson() {
    return ("{\"protocolVersion\":\"2\",\"captureId\":\"capture-1\",\"ingestionId\":\"ingestion-1\","
            + "\"kind\":\"pdf\",\"status\":\"created\",\"progress\":0.0,\"partialRevision\":0,"
            + "\"lastEventSequence\":0,\"source\":null,\"error\":null,"
            + "\"createdAt\":\"2026-08-14T00:00:00Z\",\"updatedAt\":\"2026-08-14T00:00:00Z\","
            + "\"completedAt\":null}")
        .getBytes(StandardCharsets.UTF_8);
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
