package com.gx.capture.runtime.client;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.gx.capture.runtime.client.CaptureRuntimeTypes.CaptureDocument;
import com.gx.capture.runtime.client.CaptureRuntimeTypes.CaptureEvent;
import com.gx.capture.runtime.client.CaptureRuntimeTypes.CaptureOperation;
import com.gx.capture.runtime.client.CaptureRuntimeTypes.CaptureStatus;
import com.gx.capture.runtime.client.CaptureRuntimeTypes.CaptureStreamingResult;
import com.gx.capture.runtime.client.CaptureRuntimeTypes.CaptureStructuringProvider;
import com.gx.capture.runtime.client.CaptureRuntimeTypes.CaptureCancellationContext;
import com.gx.capture.runtime.client.CaptureRuntimeTypes.FinalizeIngestion;
import com.gx.capture.runtime.client.CaptureRuntimeTypes.Ingestion;
import com.gx.capture.runtime.client.CaptureRuntimeTypes.OpenIngestion;
import com.gx.capture.runtime.client.CaptureRuntimeTypes.PartialCapture;
import com.gx.capture.runtime.client.CaptureRuntimeTypes.RawCapture;
import com.gx.capture.runtime.client.CaptureRuntimeTypes.RuntimeInstallation;
import com.gx.capture.runtime.client.CaptureRuntimeTypes.RuntimeInstallations;
import com.gx.capture.runtime.client.CaptureRuntimeTypes.RuntimeModelInstallation;
import com.gx.capture.runtime.client.CaptureRuntimeTypes.RuntimeModelOption;
import com.gx.capture.runtime.client.CaptureRuntimeTypes.RuntimeModelOptions;
import com.gx.capture.runtime.client.CaptureRuntimeTypes.RuntimeRequirement;
import com.gx.capture.runtime.client.CaptureRuntimeTypes.RuntimeRequirements;
import com.gx.capture.runtime.client.CaptureRuntimeTypes.RuntimeReady;
import com.gx.capture.runtime.client.CaptureRuntimeTypes.SourceKind;
import com.gx.capture.runtime.client.CaptureRuntimeTypes.StartCapture;
import com.gx.capture.runtime.client.CaptureRuntimeTypes.StreamingCapabilities;
import com.gx.capture.runtime.client.CaptureRuntimeTypes.StructuringMode;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.function.Function;
import java.util.regex.Pattern;

/** Typed, hash-negotiated v2 client. Only the current v2 operation and payload surface is exposed. */
public final class CaptureRuntimeClient {
  private static final int DEFAULT_CHUNK_BYTES = 1024 * 1024;
  private final RuntimeTransport transport;
  private final ObjectMapper mapper = WireCodecs.mapper();
  private final ClientOptions options;
  private volatile DiscoveredContractSet discovery;

  public CaptureRuntimeClient(RuntimeTransport transport) {
    this(transport, ClientOptions.defaults());
  }

  public CaptureRuntimeClient(RuntimeTransport transport, ClientOptions options) {
    this.transport = Objects.requireNonNull(transport, "transport");
    this.options = Objects.requireNonNull(options, "options");
  }

  public CaptureRuntimeClient(String baseUrl, String bearerToken) {
    this(new HttpRuntimeTransport(baseUrl, bearerToken));
  }

  /** Discover and pin the authenticated immutable v2 contract bundle. */
  public DiscoveredContractSet discover() {
    var current = discovery;
    if (current != null) return current;
    synchronized (this) {
      if (discovery == null) discovery = doDiscover();
      return discovery;
    }
  }

  public CaptureDocument decodeDocument(String responseBody) {
    Objects.requireNonNull(responseBody, "responseBody");
    discover();
    return WireCodecs.decode(responseBody.getBytes(StandardCharsets.UTF_8), CaptureDocument.class, mapper);
  }

  public RawCapture decodeRaw(String responseBody) {
    Objects.requireNonNull(responseBody, "responseBody");
    discover();
    return WireCodecs.decode(responseBody.getBytes(StandardCharsets.UTF_8), RawCapture.class, mapper);
  }

  /** Strictly decode a host connector payload without making a network call. */
  public static CaptureDocument decodeDocumentPayload(Object payload) {
    var mapper = WireCodecs.mapper();
    return WireCodecs.decode(WireCodecs.encode(payload, mapper), CaptureDocument.class, mapper);
  }

  public static CaptureDocument requireValidStructuringCandidate(
      RawCapture raw, CaptureDocument candidate) {
    Objects.requireNonNull(raw, "raw");
    Objects.requireNonNull(candidate, "candidate");
    if (!candidate.source().equals(raw.source())
        || !candidate.rawSegments().equals(raw.segments())
        || !candidate.sourceText().equals(raw.sourceText())
        || !candidate.extractionEngine().equals(raw.extractionEngine())
        || !candidate.createdAt().equals(raw.createdAt())
        || !candidate.warnings().containsAll(raw.warnings())) {
      throw new IllegalArgumentException("structured candidate must preserve raw capture provenance");
    }
    return candidate;
  }

  public StreamingCapabilities getStreamingCapabilities() {
    return json("GET", "/v2/streaming/health/ready", null, StreamingCapabilities.class, Map.of());
  }

  public RuntimeReady getReady() {
    return json("GET", "/v2/health/ready", null, RuntimeReady.class, Map.of());
  }

  public List<RuntimeRequirement> getRequirements() {
    return json("GET", "/v2/runtime/requirements", null, RuntimeRequirements.class, Map.of()).items();
  }

  public RuntimeInstallation startInstallation(String requirementId, String idempotencyKey) {
    return json("POST", "/v2/runtime/installations", object(Map.of("requirementId", requirementId, "consent", true)), RuntimeInstallation.class, headers("X-Idempotency-Key", requiredKey(idempotencyKey)));
  }

  public List<RuntimeInstallation> listInstallations() {
    return json("GET", "/v2/runtime/installations", null, RuntimeInstallations.class, Map.of()).items();
  }

  public RuntimeInstallation getInstallation(String id) {
    return json("GET", "/v2/runtime/installations/" + pathPart(id), null, RuntimeInstallation.class, Map.of());
  }

  public RuntimeInstallation cancelInstallation(String id) {
    return json("POST", "/v2/runtime/installations/" + pathPart(id) + "/cancel", null, RuntimeInstallation.class, Map.of());
  }

  public RuntimeModelOptions getModelOptions() {
    return json("GET", "/v2/runtime/model-options", null, RuntimeModelOptions.class, Map.of());
  }

  public RuntimeModelInstallation startModelInstallation(String optionId, String idempotencyKey) {
    return json("POST", "/v2/runtime/model-installations", object(Map.of("optionId", optionId, "consent", true)), RuntimeModelInstallation.class, headers("X-Idempotency-Key", requiredKey(idempotencyKey)));
  }

  public RuntimeModelInstallation getModelInstallation(String id) {
    return json("GET", "/v2/runtime/model-installations/" + pathPart(id), null, RuntimeModelInstallation.class, Map.of());
  }

  public RuntimeModelInstallation cancelModelInstallation(String id) {
    return json("POST", "/v2/runtime/model-installations/" + pathPart(id) + "/cancel", null, RuntimeModelInstallation.class, Map.of());
  }

  /** Upload bytes through v2 ingestion and return the started capture operation. */
  public CaptureOperation startStreamingCapture(CaptureUpload upload) {
    Objects.requireNonNull(upload, "upload");
    var digest = sha256(upload.body());
    var capabilities = getStreamingCapabilities();
    var maxChunk = Math.max(1, Math.min(DEFAULT_CHUNK_BYTES, capabilities.maxChunkBytes()));
    var open = json("POST", "/v2/ingestions", object(new OpenIngestion("2", upload.sourceKind(), CaptureRuntimeTypes.IngestionMode.FILE, upload.clientRequestId() + "-ingestion", upload.fileName(), upload.mediaType(), upload.body().length, digest)), Ingestion.class, headers("X-Idempotency-Key", requiredKey(upload.clientRequestId() + "-ingestion")));
    var ingestion = open;
    try {
      for (var offset = ingestion.nextOffset(); offset < upload.body().length; offset += maxChunk) {
        var end = (int) Math.min((long) upload.body().length, offset + maxChunk);
        var chunk = Arrays.copyOfRange(upload.body(), (int) offset, end);
        var chunkHeaders = new HashMap<String, List<String>>();
        chunkHeaders.put("Content-Range", List.of("bytes " + offset + "-" + (end - 1) + "/" + upload.body().length));
        chunkHeaders.put("Digest", List.of("sha-256=" + sha256(chunk)));
        chunkHeaders.put("X-Idempotency-Key", List.of(requiredKey(ingestion.ingestionId() + "-" + ingestion.nextChunkIndex())));
        ingestion = json("PUT", "/v2/ingestions/" + pathPart(ingestion.ingestionId()) + "/chunks/" + ingestion.nextChunkIndex(), chunk, Ingestion.class, chunkHeaders);
      }
      ingestion = json("POST", "/v2/ingestions/" + pathPart(ingestion.ingestionId()) + "/finalize", object(new FinalizeIngestion("2", upload.body().length, digest)), Ingestion.class, Map.of());
      return json("POST", "/v2/captures", object(new StartCapture("2", upload.clientRequestId(), ingestion.ingestionId(), upload.structuringMode(), upload.targetLanguage(), "eager")), CaptureOperation.class, headers("X-Idempotency-Key", requiredKey(upload.clientRequestId())));
    } catch (RuntimeException error) {
      try { json("DELETE", "/v2/ingestions/" + pathPart(ingestion.ingestionId()), null, Void.class, Map.of()); } catch (RuntimeException ignored) { }
      throw error;
    }
  }

  public CaptureOperation getStreamingCapture(String id) {
    return json("GET", "/v2/captures/" + pathPart(id), null, CaptureOperation.class, Map.of());
  }

  public PartialCapture getStreamingPartial(String id) {
    return json("GET", "/v2/captures/" + pathPart(id) + "/partial", null, PartialCapture.class, Map.of());
  }

  public CaptureStreamingResult getStreamingResult(String id) {
    return json("GET", "/v2/captures/" + pathPart(id) + "/result", null, CaptureStreamingResult.class, Map.of());
  }

  public CaptureOperation cancelStreamingCapture(String id) {
    return json("POST", "/v2/captures/" + pathPart(id) + "/cancel", null, CaptureOperation.class, Map.of());
  }

  public void deleteStreamingCapture(String id) {
    json("DELETE", "/v2/captures/" + pathPart(id), null, Void.class, Map.of());
  }

  public void deleteStreamingIngestion(String id) {
    json("DELETE", "/v2/ingestions/" + pathPart(id), null, Void.class, Map.of());
  }

  public CaptureOperation commitStreamingStructuredResult(String id, CaptureDocument candidate, String idempotencyKey) {
    return json("POST", "/v2/captures/" + pathPart(id) + "/structure/commit", object(candidate), CaptureOperation.class, headers("X-Idempotency-Key", requiredKey(idempotencyKey)));
  }

  public CaptureOperation reportStreamingStructuringFailure(String id, String code, String message, String idempotencyKey) {
    return json("POST", "/v2/captures/" + pathPart(id) + "/structure/failure", object(Map.of("protocolVersion", "2", "code", code, "message", message)), CaptureOperation.class, headers("X-Idempotency-Key", requiredKey(idempotencyKey)));
  }

  public List<CaptureEvent> captureEvents(String id) { return captureEvents(id, null); }

  public List<CaptureEvent> captureEvents(String id, Long lastEventId) {
    discover();
    var requestHeaders = new HashMap<String, List<String>>();
    requestHeaders.put("Accept", List.of("text/event-stream"));
    if (lastEventId != null) requestHeaders.put("Last-Event-ID", List.of(lastEventId.toString()));
    RuntimeTransport.RuntimeResponse response;
    try {
      response = transport.stream(new RuntimeTransport.RuntimeRequest("GET", "/v2/captures/" + pathPart(id) + "/events", requestHeaders, new byte[0]));
    } catch (IOException error) {
      throw new CaptureTransportError("Capture Runtime event stream failed", error);
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      throw new CaptureTransportError("Capture Runtime event stream was interrupted", error);
    }
    if (!response.successful()) throw CaptureRuntimeError.fromResponse(response.status(), response.body(), mapper);
    if (response.header("Content-Type") == null || !response.header("Content-Type").toLowerCase().startsWith("text/event-stream")) throw new CaptureProtocolError("Capture Runtime returned an invalid event stream");
    var events = new ArrayList<CaptureEvent>();
    long previous = lastEventId == null ? -1 : lastEventId;
    try (var reader = new BufferedReader(new InputStreamReader(response.bodyStream(), StandardCharsets.UTF_8))) {
      var data = new StringBuilder();
      String eventId = null;
      String line;
      while ((line = reader.readLine()) != null) {
        if (!line.isEmpty()) {
          if (line.startsWith(":")) continue;
          var separator = line.indexOf(':');
          var field = separator < 0 ? line : line.substring(0, separator);
          var value = separator < 0 ? "" : line.substring(separator + 1).stripLeading();
          if (field.equals("id")) eventId = value;
          else if (field.equals("data")) { if (data.length() > 0) data.append('\n'); data.append(value); }
          continue;
        }
        if (data.length() == 0) { eventId = null; continue; }
        var event = WireCodecs.decode(data.toString().getBytes(StandardCharsets.UTF_8), CaptureEvent.class, mapper);
        if (!id.equals(event.captureId()) || event.sequence() <= previous || (eventId != null && !eventId.equals(Long.toString(event.sequence())))) throw new CaptureProtocolError("Capture Runtime returned an invalid event identity or sequence");
        previous = event.sequence(); events.add(event); data.setLength(0); eventId = null;
        if (event.eventType() == CaptureRuntimeTypes.EventType.COMPLETED || event.eventType() == CaptureRuntimeTypes.EventType.FAILED || event.eventType() == CaptureRuntimeTypes.EventType.CANCELLED) break;
      }
    } catch (IOException error) {
      throw new CaptureProtocolError("Capture Runtime event stream could not be read", error);
    }
    return List.copyOf(events);
  }

  private DiscoveredContractSet doDiscover() {
    var indexResponse = request("GET", "/meta/v2/contracts", null, Map.of());
    if (!indexResponse.successful()) throw CaptureRuntimeError.fromResponse(indexResponse.status(), indexResponse.body(), mapper);
    var index = WireCodecs.node(indexResponse.body(), mapper);
    required(index, "catalogVersion", "runtimeVersion", "contractSetVersion", "surfaces", "sha256", "href");
    if (!"2".equals(index.path("catalogVersion").asText()) || !"2".equals(index.path("contractSetVersion").asText())) throw new CaptureCompatibilityError("Capture Runtime contract catalog version is incompatible");
    var surfaces = index.path("surfaces");
    if (!surfaces.isArray() || surfaces.size() != 1 || !"v2".equals(surfaces.get(0).path("id").asText())) throw new CaptureCompatibilityError("Capture Runtime exposes an unsupported surface inventory");
    var digest = index.path("sha256").asText();
    if (!digest.matches("[0-9a-f]{64}")) throw new CaptureProtocolError("Capture Runtime contract index hash is invalid");
    var href = index.path("href").asText();
    if (!href.equals("/meta/v2/contracts/sha256/" + digest)) throw new CaptureCompatibilityError("Capture Runtime contract href does not match its digest");
    var bundleResponse = request("GET", href, null, Map.of("Accept", List.of("application/json")));
    if (!bundleResponse.successful()) throw CaptureRuntimeError.fromResponse(bundleResponse.status(), bundleResponse.body(), mapper);
    var bundleHash = sha256(bundleResponse.body());
    if (!bundleHash.equals(digest) || !options.allowedContractSha256().contains(bundleHash)) throw new CaptureCompatibilityError("Capture Runtime contract bundle identity is not allowlisted");
    var etag = bundleResponse.header("ETag");
    if (etag != null && !etag.equals(bundleHash) && !etag.equals('"' + bundleHash + '"')) throw new CaptureCompatibilityError("Capture Runtime contract ETag differs from its digest");
    var bundle = WireCodecs.node(bundleResponse.body(), mapper);
    required(bundle, "contractSetVersion", "schemaDialect", "surfaces", "schemas", "operations", "problems", "invariants");
    if (!"2".equals(bundle.path("contractSetVersion").asText()) || !bundle.path("operations").isArray()) throw new CaptureCompatibilityError("Capture Runtime contract bundle is incompatible");
    var operationPaths = new HashSet<String>();
    for (var operation : bundle.path("operations")) {
      if (!operation.path("path").asText().startsWith("/v2/")) throw new CaptureCompatibilityError("Capture Runtime advertised a non-v2 operation");
      operationPaths.add(operation.path("path").asText());
    }
    if (!operationPaths.containsAll(Set.of(
        "/v2/health/ready",
        "/v2/streaming/health/ready",
        "/v2/runtime/requirements",
        "/v2/runtime/installations",
        "/v2/captures",
        "/v2/captures/{capture_id}/events",
        "/v2/captures/{capture_id}/raw",
        "/v2/captures/{capture_id}/result"))) {
      throw new CaptureCompatibilityError("Capture Runtime contract bundle is missing a required client operation");
    }
    return new DiscoveredContractSet(index, bundle, bundleHash);
  }

  private <T> T json(String method, String path, byte[] body, Class<T> type, Map<String, List<String>> headers) {
    discover();
    var response = request(method, path, body, headers);
    if (!response.successful()) throw CaptureRuntimeError.fromResponse(response.status(), response.body(), mapper);
    if (type == Void.class || response.status() == 204) return null;
    return WireCodecs.decode(response.body(), type, mapper);
  }

  private RuntimeTransport.RuntimeResponse request(String method, String path, byte[] body, Map<String, List<String>> headers) {
    var request = new RuntimeTransport.RuntimeRequest(method, path, headers, body);
    for (var attempt = 0; ; attempt++) {
      try {
        var response = transport.request(request);
        var retryable = response.status() >= 500 && ("GET".equals(method) || headers.keySet().stream().anyMatch(key -> key.equalsIgnoreCase("X-Idempotency-Key")));
        if (retryable && attempt < options.maxRetries()) continue;
        return response;
      } catch (IOException error) {
        if (attempt >= options.maxRetries()) throw new CaptureTransportError("Capture Runtime request failed", error);
      } catch (InterruptedException error) {
        Thread.currentThread().interrupt();
        throw new CaptureTransportError("Capture Runtime request was interrupted", error);
      }
    }
  }

  private byte[] object(Object value) { return WireCodecs.encode(value, mapper); }
  private static Map<String, List<String>> headers(String key, String value) { return Map.of(key, List.of(value)); }
  private static String requiredKey(String value) {
    if (value == null || value.isBlank() || value.indexOf('\r') >= 0 || value.indexOf('\n') >= 0) throw new IllegalArgumentException("idempotency key must not be blank");
    return value.strip();
  }
  private static String pathPart(String value) {
    if (value == null || value.isBlank() || value.contains("/") || value.contains("\\") || value.contains("..")) throw new IllegalArgumentException("Capture Runtime identifier is invalid");
    return URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20");
  }
  private static String sha256(byte[] bytes) { try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); } catch (Exception error) { throw new IllegalStateException(error); } }
  private static void required(JsonNode node, String... fields) { for (var field : fields) if (!node.has(field)) throw new CaptureProtocolError("Capture Runtime contract payload is missing " + field); }

  public record DiscoveredContractSet(JsonNode index, JsonNode bundle, String sha256) {
    public DiscoveredContractSet { index = index.deepCopy(); bundle = bundle.deepCopy(); }
  }

  public record ClientOptions(String expectedContractSetVersion, Set<String> allowedContractSha256, int maxRetries) {
    public ClientOptions {
      expectedContractSetVersion = expectedContractSetVersion == null ? "2" : expectedContractSetVersion.strip();
      if (!"2".equals(expectedContractSetVersion)) throw new IllegalArgumentException("only contract catalog version 2 is supported");
      allowedContractSha256 = allowedContractSha256 == null ? Set.of(CaptureRuntimeTypes.CONTRACT_SET_SHA256) : Set.copyOf(allowedContractSha256);
      if (allowedContractSha256.isEmpty()) throw new IllegalArgumentException("allowedContractSha256 must not be empty");
      if (allowedContractSha256.stream().anyMatch(value -> !value.matches("[0-9a-f]{64}"))) throw new IllegalArgumentException("allowedContractSha256 must contain lowercase SHA-256 values");
      if (maxRetries < 0 || maxRetries > 3) throw new IllegalArgumentException("maxRetries must be between 0 and 3");
    }
    public ClientOptions(String expectedContractSetVersion, Set<String> allowedContractSha256) { this(expectedContractSetVersion, allowedContractSha256, 1); }
    public static ClientOptions defaults() { return new ClientOptions("2", Set.of(CaptureRuntimeTypes.CONTRACT_SET_SHA256), 1); }
  }

  public record CaptureUpload(String fileName, byte[] body, String mediaType, SourceKind sourceKind, String targetLanguage, StructuringMode structuringMode, String clientRequestId) {
    public CaptureUpload {
      fileName = requireHeader(fileName, "fileName");
      body = Objects.requireNonNull(body, "body").clone();
      if (body.length == 0) throw new IllegalArgumentException("body must not be empty");
      mediaType = mediaType == null || mediaType.isBlank() ? "application/octet-stream" : requireHeader(mediaType, "mediaType");
      sourceKind = Objects.requireNonNull(sourceKind, "sourceKind");
      targetLanguage = targetLanguage == null ? null : requireHeader(targetLanguage, "targetLanguage");
      structuringMode = structuringMode == null ? StructuringMode.RUNTIME : structuringMode;
      clientRequestId = requiredKey(clientRequestId);
    }
    public CaptureUpload(String fileName, byte[] body, SourceKind sourceKind, String clientRequestId) { this(fileName, body, "application/octet-stream", sourceKind, null, StructuringMode.RUNTIME, clientRequestId); }
    private static String requireHeader(String value, String field) { return requiredKey(value).strip(); }
  }
}
