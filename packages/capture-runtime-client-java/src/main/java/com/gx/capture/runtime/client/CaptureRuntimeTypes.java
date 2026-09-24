package com.gx.capture.runtime.client;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.annotation.JsonSetter;
import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;
import com.fasterxml.jackson.annotation.JsonTypeName;
import com.fasterxml.jackson.annotation.JsonValue;
import com.fasterxml.jackson.annotation.Nulls;
import java.time.OffsetDateTime;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.CompletionStage;
import java.util.regex.Pattern;

/** Public, framework-neutral v2 DTOs. Wire codecs and generated schema models stay private. */
public final class CaptureRuntimeTypes {
  public static final String PROTOCOL_VERSION = "2";
  public static final String API_VERSION = "2.0";
  public static final String CONTRACT_CATALOG_VERSION = "2";
  public static final String CONTRACT_SET_VERSION = "2";
  /** Updated only as part of a coordinated runtime/client release. */
  public static final String CONTRACT_SET_SHA256 =
      "d293a3de26114f1b4fd65ea6d6d3f157fa2f93109b31e1e30d5d15ef0dfdeb40";

  private static final Pattern SHA256 = Pattern.compile("^[0-9a-f]{64}$");
  private static final Pattern FAILURE_CODE = Pattern.compile("^[a-z][a-z0-9_]{1,63}$");

  private CaptureRuntimeTypes() {}

  private static String text(String value, String field) {
    if (value == null || value.isBlank() || value.indexOf('\r') >= 0 || value.indexOf('\n') >= 0) {
      throw new IllegalArgumentException(field + " must not be blank or contain newlines");
    }
    return value.strip();
  }

  private static String bounded(String value, int max, String field) {
    value = text(value, field);
    if (value.codePointCount(0, value.length()) > max) {
      throw new IllegalArgumentException(field + " exceeds its maximum length");
    }
    return value;
  }

  private static String sha256(String value, String field) {
    value = text(value, field).toLowerCase();
    if (!SHA256.matcher(value).matches()) {
      throw new IllegalArgumentException(field + " must be a lowercase SHA-256 digest");
    }
    return value;
  }

  /** Validate canonical OCR wire values without changing malformed input into valid input. */
  private static String wireOcrSha256(String value, String field) {
    if (value == null || !OCR_SOURCE_SHA256_PATTERN.matcher(value).matches()) {
      throw new IllegalArgumentException(field + " must be a lowercase SHA-256 digest on the wire");
    }
    return value;
  }

  private static String wireOcrFailureCode(String value) {
    if (value == null || !OCR_FAILURE_CODE_PATTERN.matcher(value).matches()) {
      throw new IllegalArgumentException("failure code must use the canonical lowercase form on the wire");
    }
    return value;
  }

  private static String timestamp(String value, String field) {
    value = text(value, field);
    try {
      OffsetDateTime.parse(value);
    } catch (RuntimeException error) {
      throw new IllegalArgumentException(field + " must be an RFC 3339 timestamp", error);
    }
    return value;
  }

  private static void nonNegative(long value, String field) {
    if (value < 0) throw new IllegalArgumentException(field + " must not be negative");
  }

  private static void progress(Double value) {
    if (value != null && (!Double.isFinite(value) || value < 0 || value > 1)) {
      throw new IllegalArgumentException("progress must be between 0 and 1");
    }
  }

  private static List<String> warnings(List<String> values) {
    if (values == null) return List.of();
    return List.copyOf(values.stream().map(value -> bounded(value, 500, "warning")).toList());
  }

  /** Normalize a bounded ordered page prefix at the public Java boundary. */
  static List<Integer> pageNumbers(List<Integer> values, String field) {
    if (values == null) return null;
    if (values.isEmpty() || values.size() > 500) {
      throw new IllegalArgumentException(field + " must contain 1 to 500 pages");
    }
    for (var index = 0; index < values.size(); index++) {
      if (values.get(index) == null || values.get(index) != index + 1) {
        throw new IllegalArgumentException(field + " must be an ordered prefix from page one");
      }
    }
    return List.copyOf(values);
  }

  /** Normalize the optional PDF page prefix at the public Java boundary. */
  static List<Integer> pdfPageNumbers(List<Integer> values) {
    return pageNumbers(values, "pdfPageNumbers");
  }

  private static String project(List<RawCaptureSegment> segments) {
    return String.join("\n", segments.stream().map(RawCaptureSegment::text).toList());
  }

  public enum SourceKind {
    PDF("pdf"),
    IMAGE("image"),
    AUDIO("audio");

    private final String wireValue;

    SourceKind(String wireValue) {
      this.wireValue = wireValue;
    }

    @JsonValue
    public String wireValue() {
      return wireValue;
    }

    @JsonCreator(mode = JsonCreator.Mode.DELEGATING)
    public static SourceKind fromWireValue(String value) {
      for (var item : values()) if (item.wireValue.equals(value)) return item;
      throw new IllegalArgumentException("unknown source kind: " + value);
    }
  }

  public enum StructuringMode {
    RUNTIME("runtime"),
    HOST("host");

    private final String wireValue;

    StructuringMode(String wireValue) {
      this.wireValue = wireValue;
    }

    @JsonValue
    public String wireValue() {
      return wireValue;
    }

    @JsonCreator(mode = JsonCreator.Mode.DELEGATING)
    public static StructuringMode fromWireValue(String value) {
      for (var item : values()) if (item.wireValue.equals(value)) return item;
      throw new IllegalArgumentException("unknown structuring mode: " + value);
    }
  }

  public enum IngestionMode {
    FILE("file");

    private final String wireValue;

    IngestionMode(String wireValue) {
      this.wireValue = wireValue;
    }

    @JsonValue
    public String wireValue() {
      return wireValue;
    }

    @JsonCreator(mode = JsonCreator.Mode.DELEGATING)
    public static IngestionMode fromWireValue(String value) {
      if (FILE.wireValue.equals(value)) return FILE;
      throw new IllegalArgumentException("unknown ingestion mode: " + value);
    }
  }

  public enum IngestionStatus {
    OPEN("open"),
    FINALIZING("finalizing"),
    READY("ready"),
    CANCELLED("cancelled"),
    FAILED("failed"),
    EXPIRED("expired");

    private final String wireValue;

    IngestionStatus(String wireValue) {
      this.wireValue = wireValue;
    }

    @JsonValue
    public String wireValue() {
      return wireValue;
    }

    @JsonCreator(mode = JsonCreator.Mode.DELEGATING)
    public static IngestionStatus fromWireValue(String value) {
      for (var item : values()) if (item.wireValue.equals(value)) return item;
      throw new IllegalArgumentException("unknown ingestion status: " + value);
    }
  }

  public enum CaptureStatus {
    CREATED("created"),
    WAITING_INPUT("waiting_input"),
    EXTRACTING("extracting"),
    AWAITING_STRUCTURING("awaiting_structuring"),
    STRUCTURING("structuring"),
    COMPLETED("completed"),
    FAILED("failed"),
    CANCELLED("cancelled");

    private final String wireValue;

    CaptureStatus(String wireValue) {
      this.wireValue = wireValue;
    }

    @JsonValue
    public String wireValue() {
      return wireValue;
    }

    @JsonCreator(mode = JsonCreator.Mode.DELEGATING)
    public static CaptureStatus fromWireValue(String value) {
      for (var item : values()) if (item.wireValue.equals(value)) return item;
      throw new IllegalArgumentException("unknown capture status: " + value);
    }
  }

  public enum EventType {
    ACCEPTED("accepted"),
    INPUT_CHECKPOINT("input_checkpoint"),
    HEARTBEAT("heartbeat"),
    SEGMENT("segment"),
    CHECKPOINT("checkpoint"),
    RESYNC_REQUIRED("resync_required"),
    COMPLETED("completed"),
    FAILED("failed"),
    CANCELLED("cancelled");

    private final String wireValue;

    EventType(String wireValue) {
      this.wireValue = wireValue;
    }

    @JsonValue
    public String wireValue() {
      return wireValue;
    }

    @JsonCreator(mode = JsonCreator.Mode.DELEGATING)
    public static EventType fromWireValue(String value) {
      for (var item : values()) if (item.wireValue.equals(value)) return item;
      throw new IllegalArgumentException("unknown event type: " + value);
    }
  }

  public enum BlockType {
    HEADING("heading"),
    PARAGRAPH("paragraph"),
    LIST_ITEM("list-item"),
    TABLE("table"),
    QUOTE("quote"),
    TRANSCRIPT("transcript");

    private final String wireValue;

    BlockType(String wireValue) {
      this.wireValue = wireValue;
    }

    @JsonValue
    public String wireValue() {
      return wireValue;
    }

    @JsonCreator(mode = JsonCreator.Mode.DELEGATING)
    public static BlockType fromWireValue(String value) {
      for (var item : values()) if (item.wireValue.equals(value)) return item;
      throw new IllegalArgumentException("unknown block type: " + value);
    }
  }

  public enum StructuringSessionStatus {
    OPEN("open"),
    COMPLETED("completed"),
    FAILED("failed"),
    CANCELLED("cancelled");

    private final String wireValue;

    StructuringSessionStatus(String wireValue) { this.wireValue = wireValue; }

    @JsonValue
    public String wireValue() { return wireValue; }

    @JsonCreator(mode = JsonCreator.Mode.DELEGATING)
    public static StructuringSessionStatus fromWireValue(String value) {
      for (var item : values()) if (item.wireValue.equals(value)) return item;
      throw new IllegalArgumentException("unknown structuring session status: " + value);
    }
  }

  public enum StructuringBatchStatus {
    READY("ready"),
    ACCEPTED("accepted"),
    FAILED("failed");

    private final String wireValue;

    StructuringBatchStatus(String wireValue) { this.wireValue = wireValue; }

    @JsonValue
    public String wireValue() { return wireValue; }

    @JsonCreator(mode = JsonCreator.Mode.DELEGATING)
    public static StructuringBatchStatus fromWireValue(String value) {
      for (var item : values()) if (item.wireValue.equals(value)) return item;
      throw new IllegalArgumentException("unknown structuring batch status: " + value);
    }
  }

  @JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.PROPERTY, property = "kind")
  @JsonSubTypes({
    @JsonSubTypes.Type(value = PageLocator.class, name = "page"),
    @JsonSubTypes.Type(value = TimeLocator.class, name = "time")
  })
  public sealed interface Locator permits PageLocator, TimeLocator {}

  @JsonTypeName("page")
  public record PageLocator(@JsonProperty(required = true) int page, List<Double> boundingBox)
      implements Locator {
    public PageLocator {
      if (page < 1) throw new IllegalArgumentException("page must be positive");
      if (boundingBox != null) {
        if (boundingBox.size() != 4
            || boundingBox.stream().anyMatch(value -> value == null || !Double.isFinite(value))) {
          throw new IllegalArgumentException("boundingBox must contain four finite numbers");
        }
        boundingBox = List.copyOf(boundingBox);
      }
    }
  }

  @JsonTypeName("time")
  public record TimeLocator(
      @JsonProperty(required = true) long startMs, @JsonProperty(required = true) long endMs)
      implements Locator {
    public TimeLocator {
      nonNegative(startMs, "startMs");
      if (endMs <= startMs) throw new IllegalArgumentException("endMs must be greater than startMs");
    }
  }

  public record Source(String sha256, String fileName, String mediaType, long bytes) {
    @JsonCreator(mode = JsonCreator.Mode.PROPERTIES)
    static Source fromWire(
        @JsonProperty(value = "sha256", required = true) String sha256,
        @JsonProperty(value = "fileName", required = true) String fileName,
        @JsonProperty(value = "mediaType", required = true) String mediaType,
        @JsonProperty(value = "bytes", required = true) long bytes) {
      wireOcrSha256(sha256, "sha256");
      return new Source(sha256, fileName, mediaType, bytes);
    }

    public Source {
      sha256 = CaptureRuntimeTypes.sha256(sha256, "sha256");
      fileName = bounded(fileName, 255, "fileName");
      mediaType = text(mediaType, "mediaType");
      if (bytes < 1) throw new IllegalArgumentException("bytes must be positive");
    }
  }

  public record Engine(String engine, String model, String digest, String device) {
    public Engine {
      engine = text(engine, "engine");
      model = text(model, "model");
      digest = digest == null ? null : text(digest, "digest");
      if (digest == null || !digest.matches("^sha256:[0-9a-f]{64}$")) {
        throw new IllegalArgumentException("digest must use sha256:<hex>");
      }
      device = device == null ? null : text(device, "device");
    }
  }

  public record RawCaptureSegment(String segmentId, int order, Locator locator, String text) {
    public RawCaptureSegment {
      segmentId = CaptureRuntimeTypes.text(segmentId, "segmentId");
      nonNegative(order, "order");
      Objects.requireNonNull(locator, "locator");
      text = bounded(text, 2_000_000, "text");
    }
  }

  public record OcrPageScope(
      @JsonProperty(required = true) int sourcePageCount,
      @JsonProperty(required = true) List<Integer> requestedPageNumbers,
      @JsonProperty(required = true) List<Integer> processedPageNumbers) {
    public OcrPageScope {
      if (sourcePageCount < 1 || sourcePageCount > 500) {
        throw new IllegalArgumentException("sourcePageCount must be between 1 and 500");
      }
      requestedPageNumbers =
          Objects.requireNonNull(
              pageNumbers(requestedPageNumbers, "requestedPageNumbers"),
              "requestedPageNumbers");
      processedPageNumbers =
          Objects.requireNonNull(
              pageNumbers(processedPageNumbers, "processedPageNumbers"),
              "processedPageNumbers");
      if (requestedPageNumbers.size() > sourcePageCount) {
        throw new IllegalArgumentException("requested PDF pages must exist in the source");
      }
      if (!processedPageNumbers.equals(requestedPageNumbers)) {
        throw new IllegalArgumentException("processed PDF pages must equal requested PDF pages");
      }
    }
  }

  public record RawCapture(
      String schemaVersion,
      boolean diagnosticOnly,
      @JsonProperty(required = true) Source source,
      @JsonProperty(required = true) List<RawCaptureSegment> segments,
      @JsonProperty(required = true) String sourceText,
      @JsonProperty(required = true) Engine extractionEngine,
      @JsonSetter(nulls = Nulls.FAIL) List<String> warnings,
      @JsonProperty(required = true) String createdAt,
      OcrPageScope ocrPageScope) {
    public RawCapture {
      schemaVersion = text(schemaVersion, "schemaVersion");
      if (!"2".equals(schemaVersion)) throw new IllegalArgumentException("schemaVersion must equal 2");
      if (!diagnosticOnly) throw new IllegalArgumentException("diagnosticOnly must be true");
      Objects.requireNonNull(source, "source");
      Objects.requireNonNull(segments, "segments");
      if (segments.isEmpty() || segments.size() > 10_000) throw new IllegalArgumentException("segments must contain 1 to 10000 items");
      segments = List.copyOf(segments);
      var ids = new HashSet<String>();
      for (var index = 0; index < segments.size(); index++) {
        var segment = Objects.requireNonNull(segments.get(index), "segment");
        if (segment.order() != index || !ids.add(segment.segmentId())) throw new IllegalArgumentException("raw segment order/id values are invalid");
      }
      sourceText = bounded(sourceText, 8_000_000, "sourceText");
      if (!sourceText.equals(project(segments))) throw new IllegalArgumentException("sourceText projection differs");
      extractionEngine = Objects.requireNonNull(extractionEngine, "extractionEngine");
      warnings = CaptureRuntimeTypes.warnings(warnings);
      createdAt = timestamp(createdAt, "createdAt");
      ocrPageScope = ocrPageScope == null ? null : Objects.requireNonNull(ocrPageScope, "ocrPageScope");
    }

    public RawCapture(
        String schemaVersion,
        boolean diagnosticOnly,
        Source source,
        List<RawCaptureSegment> segments,
        String sourceText,
        Engine extractionEngine,
        List<String> warnings,
        String createdAt) {
      this(schemaVersion, diagnosticOnly, source, segments, sourceText, extractionEngine, warnings, createdAt, null);
    }
  }

  public record Block(
      String blockId,
      int order,
      BlockType type,
      String sourceSegmentId,
      Locator locator,
      String sourceText,
      String targetText) {
    public Block {
      blockId = text(blockId, "blockId");
      nonNegative(order, "order");
      Objects.requireNonNull(type, "type");
      sourceSegmentId = text(sourceSegmentId, "sourceSegmentId");
      Objects.requireNonNull(locator, "locator");
      sourceText = bounded(sourceText, 2_000_000, "sourceText");
      targetText = bounded(targetText, 2_000_000, "targetText");
    }
  }

  public record CaptureDocument(
      String schemaVersion,
      Source source,
      List<RawCaptureSegment> rawSegments,
      List<Block> blocks,
      String sourceText,
      String targetText,
      Engine extractionEngine,
      Engine structuringEngine,
      @JsonSetter(nulls = Nulls.FAIL) List<String> warnings,
      String createdAt,
      String completedAt) {
    public CaptureDocument {
      schemaVersion = text(schemaVersion, "schemaVersion");
      if (!"2".equals(schemaVersion)) throw new IllegalArgumentException("schemaVersion must equal 2");
      Objects.requireNonNull(source, "source");
      Objects.requireNonNull(rawSegments, "rawSegments");
      Objects.requireNonNull(blocks, "blocks");
      extractionEngine = Objects.requireNonNull(extractionEngine, "extractionEngine");
      structuringEngine = Objects.requireNonNull(structuringEngine, "structuringEngine");
      if (rawSegments.isEmpty() || blocks.isEmpty() || rawSegments.size() != blocks.size()) throw new IllegalArgumentException("rawSegments and blocks must have matching non-empty sizes");
      rawSegments = List.copyOf(rawSegments);
      blocks = List.copyOf(blocks);
      var segmentIds = new HashSet<String>();
      var blockIds = new HashSet<String>();
      for (var index = 0; index < rawSegments.size(); index++) {
        var segment = Objects.requireNonNull(rawSegments.get(index), "rawSegment");
        var block = Objects.requireNonNull(blocks.get(index), "block");
        if (segment.order() != index || !segmentIds.add(segment.segmentId()) || block.order() != index || !blockIds.add(block.blockId())) throw new IllegalArgumentException("document order/id values are invalid");
        if (!block.sourceSegmentId().equals(segment.segmentId()) || !block.locator().equals(segment.locator()) || !block.sourceText().equals(segment.text())) throw new IllegalArgumentException("block provenance differs from raw segment");
      }
      sourceText = bounded(sourceText, 8_000_000, "sourceText");
      targetText = bounded(targetText, 8_000_000, "targetText");
      if (!sourceText.equals(project(rawSegments))) throw new IllegalArgumentException("sourceText projection differs");
      if (!targetText.equals(String.join("\n", blocks.stream().map(Block::targetText).toList()))) throw new IllegalArgumentException("targetText projection differs");
      warnings = CaptureRuntimeTypes.warnings(warnings);
      createdAt = timestamp(createdAt, "createdAt");
      completedAt = timestamp(completedAt, "completedAt");
      if (OffsetDateTime.parse(completedAt).isBefore(OffsetDateTime.parse(createdAt))) throw new IllegalArgumentException("completedAt precedes createdAt");
    }
  }

  @FunctionalInterface
  public interface CaptureCancellationContext {
    boolean isCancellationRequested();
  }

  @FunctionalInterface
  public interface CaptureStructuringProvider {
    CompletionStage<CaptureDocument> structure(
        RawCapture rawCapture, Optional<String> targetLanguage, CaptureCancellationContext cancellationContext);
  }

  public record Failure(String code, String message, String stage, boolean retryable) {
    @JsonCreator(mode = JsonCreator.Mode.PROPERTIES)
    static Failure fromWire(
        @JsonProperty(value = "code", required = true) String code,
        @JsonProperty(value = "message", required = true) String message,
        @JsonProperty(value = "stage") String stage,
        @JsonProperty(value = "retryable") boolean retryable) {
      wireOcrFailureCode(code);
      return new Failure(code, message, stage, retryable);
    }

    public Failure {
      code = text(code, "code").toLowerCase();
      if (!FAILURE_CODE.matcher(code).matches()) throw new IllegalArgumentException("invalid failure code");
      message = bounded(message, 500, "message");
      stage = stage == null ? null : text(stage, "stage");
    }
  }

  public record OpenIngestion(
      String protocolVersion,
      SourceKind kind,
      IngestionMode mode,
      String clientRequestId,
      String fileName,
      String mediaType,
      long totalBytes,
      String sourceSha256) {
    public OpenIngestion {
      protocolVersion = protocolVersion == null ? PROTOCOL_VERSION : text(protocolVersion, "protocolVersion");
      if (!PROTOCOL_VERSION.equals(protocolVersion)) throw new IllegalArgumentException("protocolVersion must equal 2");
      kind = kind == null ? SourceKind.AUDIO : kind;
      mode = mode == null ? IngestionMode.FILE : mode;
      clientRequestId = text(clientRequestId, "clientRequestId");
      fileName = bounded(fileName, 255, "fileName");
      mediaType = text(mediaType, "mediaType");
      if (totalBytes < 1) throw new IllegalArgumentException("totalBytes must be positive");
      sourceSha256 = sourceSha256 == null ? null : sha256(sourceSha256, "sourceSha256");
    }
  }

  public record Ingestion(
      String protocolVersion,
      SourceKind kind,
      String ingestionId,
      IngestionStatus status,
      String fileName,
      String mediaType,
      long totalBytes,
      long receivedBytes,
      long contiguousBytes,
      long nextChunkIndex,
      long nextOffset,
      String sourceSha256,
      String finalizedSha256,
      String expiresAt) {
    public Ingestion {
      protocolVersion = protocolVersion == null ? PROTOCOL_VERSION : text(protocolVersion, "protocolVersion");
      if (!PROTOCOL_VERSION.equals(protocolVersion)) throw new IllegalArgumentException("protocolVersion must equal 2");
      kind = kind == null ? SourceKind.AUDIO : kind;
      ingestionId = text(ingestionId, "ingestionId");
      status = Objects.requireNonNull(status, "status");
      fileName = bounded(fileName, 255, "fileName");
      mediaType = text(mediaType, "mediaType");
      if (totalBytes < 1) throw new IllegalArgumentException("totalBytes must be positive");
      nonNegative(receivedBytes, "receivedBytes");
      nonNegative(contiguousBytes, "contiguousBytes");
      nonNegative(nextChunkIndex, "nextChunkIndex");
      nonNegative(nextOffset, "nextOffset");
      if (receivedBytes > totalBytes || contiguousBytes > receivedBytes || nextOffset != contiguousBytes) throw new IllegalArgumentException("ingestion byte accounting is invalid");
      sourceSha256 = sourceSha256 == null ? null : sha256(sourceSha256, "sourceSha256");
      finalizedSha256 = finalizedSha256 == null ? null : sha256(finalizedSha256, "finalizedSha256");
      expiresAt = timestamp(expiresAt, "expiresAt");
    }
  }

  public record FinalizeIngestion(String protocolVersion, long totalBytes, String sha256) {
    public FinalizeIngestion {
      protocolVersion = protocolVersion == null ? PROTOCOL_VERSION : text(protocolVersion, "protocolVersion");
      if (!PROTOCOL_VERSION.equals(protocolVersion)) throw new IllegalArgumentException("protocolVersion must equal 2");
      if (totalBytes < 1) throw new IllegalArgumentException("totalBytes must be positive");
      sha256 = CaptureRuntimeTypes.sha256(sha256, "sha256");
    }
  }

  public record StartCapture(
      String protocolVersion,
      String clientRequestId,
      String ingestionId,
      StructuringMode structuringMode,
      String targetLanguage,
      String startPolicy,
      List<Integer> pdfPageNumbers) {
    public StartCapture {
      protocolVersion = protocolVersion == null ? PROTOCOL_VERSION : text(protocolVersion, "protocolVersion");
      if (!PROTOCOL_VERSION.equals(protocolVersion)) throw new IllegalArgumentException("protocolVersion must equal 2");
      clientRequestId = text(clientRequestId, "clientRequestId");
      ingestionId = text(ingestionId, "ingestionId");
      structuringMode = Objects.requireNonNull(structuringMode, "structuringMode");
      targetLanguage = targetLanguage == null ? null : bounded(targetLanguage, 64, "targetLanguage");
      startPolicy = startPolicy == null ? "eager" : text(startPolicy, "startPolicy");
      if (!"eager".equals(startPolicy)) throw new IllegalArgumentException("startPolicy must equal eager");
      pdfPageNumbers = CaptureRuntimeTypes.pdfPageNumbers(pdfPageNumbers);
    }

    public StartCapture(
        String protocolVersion,
        String clientRequestId,
        String ingestionId,
        StructuringMode structuringMode,
        String targetLanguage,
        String startPolicy) {
      this(protocolVersion, clientRequestId, ingestionId, structuringMode, targetLanguage, startPolicy, null);
    }
  }

  // BEGIN GENERATED OCR PROJECTION
  // Generated from capture-ocr-projection-v3.schema.json in contract-set.json. Do not edit.
  private static final String OCR_RUNTIME_VERSION = "0.4.2";
  private static final Pattern OCR_SOURCE_SHA256_PATTERN = Pattern.compile("^[0-9a-f]{64}$");
  private static final Pattern OCR_FAILURE_CODE_PATTERN = Pattern.compile("^[a-z][a-z0-9_]{1,63}$");

  public enum OcrProjectionStatus {
    COMPLETED("completed"),
    FAILED("failed");

    private final String wireValue;

    OcrProjectionStatus(String wireValue) {
      this.wireValue = wireValue;
    }

    @JsonValue
    public String wireValue() {
      return wireValue;
    }

    @JsonCreator(mode = JsonCreator.Mode.DELEGATING)
    public static OcrProjectionStatus fromWireValue(String value) {
      for (var item : values()) {
        if (item.wireValue.equals(value)) return item;
      }
      throw new IllegalArgumentException("unknown OCR OcrProjectionStatus: " + value);
    }
  }

  public enum OcrPageStatus {
    RECOGNIZED("recognized"),
    EMPTY("empty"),
    FAILED("failed");

    private final String wireValue;

    OcrPageStatus(String wireValue) {
      this.wireValue = wireValue;
    }

    @JsonValue
    public String wireValue() {
      return wireValue;
    }

    @JsonCreator(mode = JsonCreator.Mode.DELEGATING)
    public static OcrPageStatus fromWireValue(String value) {
      for (var item : values()) {
        if (item.wireValue.equals(value)) return item;
      }
      throw new IllegalArgumentException("unknown OCR OcrPageStatus: " + value);
    }
  }

  public record OcrRaster(
      @JsonProperty(required = true) long width,
      @JsonProperty(required = true) long height,
      @JsonProperty(required = true) double scale,
      @JsonProperty(required = true) String coordinateSystem) {
    public OcrRaster {
      if (width <= 0 || height <= 0 || !Double.isFinite(scale) || scale <= 0 || scale > 8) {
        throw new IllegalArgumentException("OCR raster metadata is invalid");
      }
      coordinateSystem = ocrText(coordinateSystem, 1, 5, "coordinateSystem");
      if (!"pixel".equals(coordinateSystem)) {
        throw new IllegalArgumentException("coordinateSystem must equal pixel");
      }
    }
  }

  public record OcrPoint(
      @JsonProperty(required = true) double x,
      @JsonProperty(required = true) double y) {
    public OcrPoint {
      if (!Double.isFinite(x) || x < 0 || !Double.isFinite(y) || y < 0) {
        throw new IllegalArgumentException("OCR polygon coordinates must be finite and non-negative");
      }
    }
  }

  public record OcrBox(
      @JsonProperty(required = true) List<OcrPoint> polygon,
      @JsonProperty(required = true) String text,
      @JsonProperty(required = true) Double confidence) {
    public OcrBox {
      polygon = List.copyOf(Objects.requireNonNull(polygon, "polygon"));
      if (polygon.size() < 4 || polygon.size() > 256) {
        throw new IllegalArgumentException("OCR polygon point count must be between 4 and 256");
      }
      text = ocrText(text, 1, 8000000, "text");
      if (confidence != null && (!Double.isFinite(confidence) || confidence < 0 || confidence > 1)) {
        throw new IllegalArgumentException("OCR box confidence is outside the canonical range");
      }
    }
  }

  private static String ocrText(String value, long minimum, long maximum, String field) {
    if (value == null) throw new IllegalArgumentException(field + " must not be null");
    value = value.strip();
    var length = value.codePointCount(0, value.length());
    if (length < minimum || length > maximum) {
      throw new IllegalArgumentException(field + " length is outside the canonical range");
    }
    return value;
  }

  private static String ocrSha256(String value, String field) {
    value = ocrText(value, 64, 64, field);
    if (!value.matches("^[0-9a-f]{64}$")) {
      throw new IllegalArgumentException(field + " must be a lowercase SHA-256 digest");
    }
    return value;
  }

  public enum OcrProvenanceUnavailableReason {
    MODEL_UNAVAILABLE("model_unavailable"),
    WORKER_CRASHED("worker_crashed"),
    WORKER_TIMEOUT("worker_timeout"),
    PROTOCOL_FAILURE("protocol_failure");

    private final String wireValue;

    OcrProvenanceUnavailableReason(String wireValue) {
      this.wireValue = wireValue;
    }

    @JsonValue
    public String wireValue() {
      return wireValue;
    }

    @JsonCreator(mode = JsonCreator.Mode.DELEGATING)
    public static OcrProvenanceUnavailableReason fromWireValue(String value) {
      for (var item : values()) {
        if (item.wireValue.equals(value)) return item;
      }
      throw new IllegalArgumentException("unknown OCR OcrProvenanceUnavailableReason: " + value);
    }
  }

  @JsonTypeInfo(
      use = JsonTypeInfo.Id.NAME,
      include = JsonTypeInfo.As.EXISTING_PROPERTY,
      property = "status",
      visible = true)
  @JsonSubTypes({
    @JsonSubTypes.Type(value = OcrProvenanceResolved.class, name = "resolved"),
    @JsonSubTypes.Type(value = OcrProvenanceUnavailable.class, name = "unavailable")
  })
  public sealed interface OcrProvenance
      permits OcrProvenanceResolved, OcrProvenanceUnavailable {
    String status();

    String profileId();

    String profileSpecSha256();
  }

  @JsonTypeName("resolved")
  public record OcrProvenanceResolved(
      @JsonProperty(required = true) String status,
      @JsonProperty(required = true) String engine,
      @JsonProperty(required = true) String model,
      @JsonProperty(required = true) String modelDigest,
      @JsonProperty(required = true) String device,
      @JsonProperty(required = true) String profileId,
      @JsonProperty(required = true) String profileSpecSha256) implements OcrProvenance {
    public OcrProvenanceResolved {
      if (!"resolved".equals(status)) throw new IllegalArgumentException("OCR resolved provenance status must equal resolved");
      engine = ocrText(engine, 1, Long.MAX_VALUE, "engine");
      if (!"windowsml-ocr".equals(engine)) throw new IllegalArgumentException("OCR engine must equal windowsml-ocr");
      model = ocrText(model, 1, Long.MAX_VALUE, "model");
      modelDigest = ocrText(modelDigest, 1, Long.MAX_VALUE, "modelDigest");
      if (!modelDigest.matches("^sha256:[0-9a-f]{64}$") || "sha256:0000000000000000000000000000000000000000000000000000000000000000".equals(modelDigest)) {
        throw new IllegalArgumentException("modelDigest is not a resolved model digest");
      }
      device = ocrText(device, 1, Long.MAX_VALUE, "device");
      profileId = ocrText(profileId, 1, Long.MAX_VALUE, "profileId");
      profileSpecSha256 = ocrSha256(profileSpecSha256, "profileSpecSha256");
    }
  }

  @JsonTypeName("unavailable")
  public record OcrProvenanceUnavailable(
      @JsonProperty(required = true) String status,
      @JsonProperty(required = true) String profileId,
      @JsonProperty(required = true) String profileSpecSha256,
      @JsonProperty(required = true) OcrProvenanceUnavailableReason reason) implements OcrProvenance {
    public OcrProvenanceUnavailable {
      if (!"unavailable".equals(status)) throw new IllegalArgumentException("OCR unavailable provenance status must equal unavailable");
      profileId = ocrText(profileId, 1, Long.MAX_VALUE, "profileId");
      profileSpecSha256 = ocrSha256(profileSpecSha256, "profileSpecSha256");
      reason = Objects.requireNonNull(reason, "reason");
    }
  }

  private static List<String> ocrWarnings(List<String> values) {
    if (values == null) return List.of();
    if (values.size() > 1000) throw new IllegalArgumentException("OCR warnings exceed the canonical limit");
    return List.copyOf(values.stream().map(value -> ocrText(value, 0, 500, "warning")).toList());
  }

  public record OcrPageProjection(
      @JsonProperty(required = true) long page,
      @JsonProperty(required = true) OcrPageStatus status,
      @JsonProperty(required = true) OcrRaster raster,
      String text,
      List<OcrBox> boxes,
      Double confidence,
      @JsonProperty(required = true) OcrProvenance provenance,
      Failure failure) {
    public OcrPageProjection {
      if (page < 1) throw new IllegalArgumentException("OCR page must be positive");
      status = Objects.requireNonNull(status, "status");
      raster = Objects.requireNonNull(raster, "raster");
      text = text == null ? "" : ocrText(text, 0, 8000000, "text");
      boxes = boxes == null ? List.of() : List.copyOf(boxes);
      if (boxes.size() > 100000) throw new IllegalArgumentException("OCR boxes exceed the canonical limit");
      if (confidence != null && (!Double.isFinite(confidence) || confidence < 0 || confidence > 1)) throw new IllegalArgumentException("OCR confidence is outside the canonical range");
      provenance = Objects.requireNonNull(provenance, "provenance");
      if ((status == OcrPageStatus.RECOGNIZED || status == OcrPageStatus.EMPTY) && !(provenance instanceof OcrProvenanceResolved)) throw new IllegalArgumentException("recognized and empty OCR pages require resolved provenance");
      if (status == OcrPageStatus.RECOGNIZED && (text.isBlank() || confidence == null || failure != null)) throw new IllegalArgumentException("recognized OCR page is invalid");
      if (status == OcrPageStatus.EMPTY && (!text.isBlank() || !boxes.isEmpty() || confidence != null || failure != null)) throw new IllegalArgumentException("empty OCR page is invalid");
      if (status == OcrPageStatus.FAILED && (!text.isBlank() || !boxes.isEmpty() || confidence != null || failure == null)) throw new IllegalArgumentException("failed OCR page is invalid");
      for (var box : boxes) for (var point : box.polygon()) if (point.x() > raster.width() || point.y() > raster.height()) throw new IllegalArgumentException("OCR polygon must stay inside the raw raster bounds");
    }
  }

  public record CaptureOcrProjection(
      @JsonProperty(required = true) String apiVersion,
      @JsonProperty(required = true) String schemaVersion,
      @JsonProperty(required = true) String captureId,
      @JsonProperty(required = true) OcrProjectionStatus status,
      Source source,
      @JsonProperty(required = true) List<OcrPageProjection> pages,
      @JsonProperty(required = true) long pageCount,
      @JsonProperty(required = true) String runtimeVersion,
      @JsonProperty(required = true) String contractSha256,
      @JsonProperty(required = true) OcrProvenance provenance,
      List<String> warnings,
      Failure failure,
      @JsonProperty(required = true) String createdAt) {
    public CaptureOcrProjection {
      apiVersion = ocrText(apiVersion, 1, 3, "apiVersion"); if (!"2.0".equals(apiVersion)) throw new IllegalArgumentException("apiVersion is incompatible");
      schemaVersion = ocrText(schemaVersion, 1, 1, "schemaVersion"); if (!"3".equals(schemaVersion)) throw new IllegalArgumentException("schemaVersion is incompatible");
      captureId = ocrText(captureId, 1, Long.MAX_VALUE, "captureId");
      status = Objects.requireNonNull(status, "status");
      pages = List.copyOf(Objects.requireNonNull(pages, "pages"));
      if (pageCount < 0 || pageCount > 500 || pageCount != pages.size()) throw new IllegalArgumentException("pageCount must equal pages.size() and stay in the canonical range");
      if (pages.size() > 500) throw new IllegalArgumentException("OCR pages exceed the canonical limit");
      runtimeVersion = ocrText(runtimeVersion, 1, 5, "runtimeVersion"); if (!OCR_RUNTIME_VERSION.equals(runtimeVersion)) throw new IllegalArgumentException("runtimeVersion is incompatible");
      contractSha256 = ocrSha256(contractSha256, "contractSha256");
      provenance = Objects.requireNonNull(provenance, "provenance");
      for (var index = 0; index < pages.size(); index++) {
        var page = pages.get(index);
        if (page.page() != index + 1) throw new IllegalArgumentException("OCR pages must be complete and ordered from page one");
        if (!provenance.equals(page.provenance())) throw new IllegalArgumentException("page OCR provenance must match document provenance");
      }
      warnings = ocrWarnings(warnings);
      createdAt = timestamp(createdAt, "createdAt");
      if (status == OcrProjectionStatus.COMPLETED && (pages.isEmpty() || source == null || failure != null)) throw new IllegalArgumentException("completed OCR projections require pages, source, provenance, and no failure");
      if (status == OcrProjectionStatus.COMPLETED && !(provenance instanceof OcrProvenanceResolved)) throw new IllegalArgumentException("completed OCR projections require resolved provenance");
      if (status == OcrProjectionStatus.COMPLETED && pages.stream().anyMatch(page -> page.status() == OcrPageStatus.FAILED)) throw new IllegalArgumentException("completed OCR projections must not contain failed pages");
      if (status == OcrProjectionStatus.COMPLETED && pages.stream().noneMatch(page -> page.status() == OcrPageStatus.RECOGNIZED)) throw new IllegalArgumentException("completed OCR projections require recognized text");
      if (status == OcrProjectionStatus.FAILED && failure == null) throw new IllegalArgumentException("failed OCR projection requires failure");
    }
  }
  // END GENERATED OCR PROJECTION

  public record StructuringProviderCapability(
      Engine provider, String capability, String schemaDialect) {
    public StructuringProviderCapability {
      provider = Objects.requireNonNull(provider, "provider");
      capability = text(capability, "capability");
      schemaDialect = text(schemaDialect, "schemaDialect");
    }
  }

  public record OpenStructuringSession(
      String captureId,
      StructuringProviderCapability providerCapability,
      String schemaDialect,
      String clientRequestId,
      String targetLanguage,
      String protocolVersion) {
    public OpenStructuringSession {
      protocolVersion = protocolVersion == null ? PROTOCOL_VERSION : text(protocolVersion, "protocolVersion");
      if (!PROTOCOL_VERSION.equals(protocolVersion)) throw new IllegalArgumentException("protocolVersion must equal 2");
      captureId = text(captureId, "captureId");
      providerCapability = Objects.requireNonNull(providerCapability, "providerCapability");
      schemaDialect = text(schemaDialect, "schemaDialect");
      clientRequestId = text(clientRequestId, "clientRequestId");
      targetLanguage = targetLanguage == null ? null : bounded(targetLanguage, 64, "targetLanguage");
    }
  }

  public record StructuringSession(
      String protocolVersion,
      String sessionId,
      String captureId,
      String rawSourceSha256,
      String contractSetSha256,
      StructuringProviderCapability providerCapability,
      String schemaDialect,
      int batchCount,
      int nextBatchIndex,
      String sessionDigest,
      StructuringSessionStatus status,
      String targetLanguage,
      String createdAt,
      String updatedAt,
      String completedAt) {
    public StructuringSession {
      protocolVersion = protocolVersion == null ? PROTOCOL_VERSION : text(protocolVersion, "protocolVersion");
      if (!PROTOCOL_VERSION.equals(protocolVersion)) throw new IllegalArgumentException("protocolVersion must equal 2");
      sessionId = text(sessionId, "sessionId");
      captureId = text(captureId, "captureId");
      rawSourceSha256 = sha256(rawSourceSha256, "rawSourceSha256");
      contractSetSha256 = sha256(contractSetSha256, "contractSetSha256");
      providerCapability = Objects.requireNonNull(providerCapability, "providerCapability");
      schemaDialect = text(schemaDialect, "schemaDialect");
      if (batchCount < 1) throw new IllegalArgumentException("batchCount must be positive");
      if (nextBatchIndex < 0 || nextBatchIndex > batchCount) throw new IllegalArgumentException("nextBatchIndex is invalid");
      sessionDigest = sha256(sessionDigest, "sessionDigest");
      status = Objects.requireNonNull(status, "status");
      targetLanguage = targetLanguage == null ? null : bounded(targetLanguage, 64, "targetLanguage");
      createdAt = timestamp(createdAt, "createdAt");
      updatedAt = timestamp(updatedAt, "updatedAt");
      completedAt = completedAt == null ? null : timestamp(completedAt, "completedAt");
      boolean terminal = status != StructuringSessionStatus.OPEN;
      if (terminal != (completedAt != null)) throw new IllegalArgumentException("terminal sessions require completedAt");
    }
  }

  public record StructuringBatch(
      String protocolVersion,
      String sessionId,
      String captureId,
      int batchIndex,
      int batchCount,
      List<String> sourceSegmentIds,
      Map<String, Object> providerPrompt,
      Map<String, Object> providerSchema,
      int numCtx,
      int numPredict,
      String batchDigest,
      StructuringBatchStatus status) {
    public StructuringBatch {
      protocolVersion = protocolVersion == null ? PROTOCOL_VERSION : text(protocolVersion, "protocolVersion");
      if (!PROTOCOL_VERSION.equals(protocolVersion)) throw new IllegalArgumentException("protocolVersion must equal 2");
      sessionId = text(sessionId, "sessionId");
      captureId = text(captureId, "captureId");
      if (batchIndex < 0 || batchCount < 1 || batchIndex >= batchCount) throw new IllegalArgumentException("batch index/count is invalid");
      sourceSegmentIds = sourceSegmentIds == null || sourceSegmentIds.isEmpty() ? List.of() : List.copyOf(sourceSegmentIds.stream().map(value -> text(value, "sourceSegmentId")).toList());
      if (sourceSegmentIds.isEmpty()) throw new IllegalArgumentException("sourceSegmentIds must not be empty");
      providerPrompt = providerPrompt == null ? Map.of() : Map.copyOf(providerPrompt);
      providerSchema = providerSchema == null ? Map.of() : Map.copyOf(providerSchema);
      if (numCtx < 1 || numPredict < 1) throw new IllegalArgumentException("batch budgets must be positive");
      batchDigest = sha256(batchDigest, "batchDigest");
      status = Objects.requireNonNull(status, "status");
    }
  }

  public record StructuringSemanticBlock(String sourceSegmentId, BlockType type, String targetText) {
    public StructuringSemanticBlock {
      sourceSegmentId = text(sourceSegmentId, "sourceSegmentId");
      type = Objects.requireNonNull(type, "type");
      targetText = targetText == null ? null : bounded(targetText, 2_000_000, "targetText");
    }
  }

  public record SubmitStructuringBatch(
      String batchDigest, List<StructuringSemanticBlock> blocks, String protocolVersion) {
    public SubmitStructuringBatch {
      protocolVersion = protocolVersion == null ? PROTOCOL_VERSION : text(protocolVersion, "protocolVersion");
      if (!PROTOCOL_VERSION.equals(protocolVersion)) throw new IllegalArgumentException("protocolVersion must equal 2");
      batchDigest = sha256(batchDigest, "batchDigest");
      if (blocks == null || blocks.isEmpty()) throw new IllegalArgumentException("blocks must not be empty");
      blocks = List.copyOf(blocks.stream().map(value -> Objects.requireNonNull(value, "block")).toList());
    }
  }

  public record CaptureOperation(
      String protocolVersion,
      String captureId,
      String ingestionId,
      SourceKind kind,
      CaptureStatus status,
      Double progress,
      long partialRevision,
      long lastEventSequence,
      Source source,
      Failure error,
      String createdAt,
      String updatedAt,
      String completedAt) {
    public CaptureOperation {
      protocolVersion = protocolVersion == null ? PROTOCOL_VERSION : text(protocolVersion, "protocolVersion");
      if (!PROTOCOL_VERSION.equals(protocolVersion)) throw new IllegalArgumentException("protocolVersion must equal 2");
      captureId = text(captureId, "captureId");
      ingestionId = text(ingestionId, "ingestionId");
      kind = kind == null ? SourceKind.AUDIO : kind;
      status = Objects.requireNonNull(status, "status");
      CaptureRuntimeTypes.progress(progress);
      nonNegative(partialRevision, "partialRevision");
      nonNegative(lastEventSequence, "lastEventSequence");
      createdAt = timestamp(createdAt, "createdAt");
      updatedAt = timestamp(updatedAt, "updatedAt");
      completedAt = completedAt == null ? null : timestamp(completedAt, "completedAt");
      var terminal = status == CaptureStatus.COMPLETED || status == CaptureStatus.FAILED || status == CaptureStatus.CANCELLED;
      if (terminal != (completedAt != null)) throw new IllegalArgumentException("terminal captures require completedAt");
    }
  }

  public record PartialCapture(String protocolVersion, String captureId, Source source, long revision, long coveredUntilMs, List<RawCaptureSegment> segments, String sourceText, Engine extractionEngine, String updatedAt) {
    public PartialCapture {
      protocolVersion = protocolVersion == null ? PROTOCOL_VERSION : text(protocolVersion, "protocolVersion");
      if (!PROTOCOL_VERSION.equals(protocolVersion)) throw new IllegalArgumentException("protocolVersion must equal 2");
      captureId = text(captureId, "captureId");
      source = Objects.requireNonNull(source, "source");
      nonNegative(revision, "revision");
      nonNegative(coveredUntilMs, "coveredUntilMs");
      segments = segments == null ? List.of() : List.copyOf(segments);
      sourceText = sourceText == null ? "" : bounded(sourceText, 8_000_000, "sourceText");
      if (!sourceText.equals(project(segments))) throw new IllegalArgumentException("partial sourceText projection differs");
      updatedAt = timestamp(updatedAt, "updatedAt");
    }
  }

  public record CaptureEvent(String protocolVersion, String eventId, long sequence, String captureId, SourceKind kind, EventType eventType, String stage, Double progress, Long partialRevision, Long coveredUntilMs, List<RawCaptureSegment> segments, Failure error, String createdAt) {
    public CaptureEvent {
      protocolVersion = protocolVersion == null ? PROTOCOL_VERSION : text(protocolVersion, "protocolVersion");
      if (!PROTOCOL_VERSION.equals(protocolVersion)) throw new IllegalArgumentException("protocolVersion must equal 2");
      eventId = text(eventId, "eventId");
      nonNegative(sequence, "sequence");
      captureId = text(captureId, "captureId");
      if (!eventId.equals(captureId + "/" + sequence)) throw new IllegalArgumentException("eventId must equal captureId/sequence");
      kind = kind == null ? SourceKind.AUDIO : kind;
      eventType = Objects.requireNonNull(eventType, "eventType");
      stage = text(stage, "stage");
      CaptureRuntimeTypes.progress(progress);
      if (partialRevision != null) nonNegative(partialRevision, "partialRevision");
      if (coveredUntilMs != null) nonNegative(coveredUntilMs, "coveredUntilMs");
      segments = segments == null ? List.of() : List.copyOf(segments);
      if (eventType == EventType.SEGMENT && segments.isEmpty()) throw new IllegalArgumentException("segment events require segments");
      if ((eventType == EventType.FAILED) != (error != null)) throw new IllegalArgumentException("only failed events may contain an error");
      createdAt = timestamp(createdAt, "createdAt");
    }
  }

  public record StreamingCapabilities(String protocolVersion, List<SourceKind> captureKinds, Boolean supportsProgressiveAudio, long maxChunkBytes, long checkpointIntervalMs, long heartbeatIntervalMs, long stallTimeoutMs) {
    public StreamingCapabilities {
      protocolVersion = protocolVersion == null ? PROTOCOL_VERSION : text(protocolVersion, "protocolVersion");
      if (!PROTOCOL_VERSION.equals(protocolVersion)) throw new IllegalArgumentException("protocolVersion must equal 2");
      captureKinds = captureKinds == null ? List.of(SourceKind.PDF, SourceKind.IMAGE, SourceKind.AUDIO) : List.copyOf(captureKinds);
      if (captureKinds.isEmpty()) throw new IllegalArgumentException("captureKinds must not be empty");
      supportsProgressiveAudio = supportsProgressiveAudio == null ? Boolean.TRUE : supportsProgressiveAudio;
      if (maxChunkBytes < 1 || maxChunkBytes > 4_194_304 || checkpointIntervalMs < 1 || heartbeatIntervalMs < 1 || stallTimeoutMs < 1) throw new IllegalArgumentException("streaming limits must be positive and bounded");
    }
  }

  public record CaptureStreamingResult(CaptureOperation operation, RawCapture raw, CaptureDocument result) {
    public CaptureStreamingResult {
      Objects.requireNonNull(operation, "operation");
      Objects.requireNonNull(raw, "raw");
      Objects.requireNonNull(result, "result");
      if (!raw.source().equals(result.source()) || (operation.source() != null && !operation.source().equals(raw.source()))) throw new IllegalArgumentException("capture source identity differs");
    }
  }

  public record RuntimeArtifactDescriptor(
      String artifactUrl, String artifactFileName, long bytes, String sha256) {
    public RuntimeArtifactDescriptor {
      artifactUrl = text(artifactUrl, "artifactUrl");
      artifactFileName = text(artifactFileName, "artifactFileName");
      if (bytes < 1 || bytes > 536_870_912L)
        throw new IllegalArgumentException("bytes must be between 1 and 536870912");
      sha256 = CaptureRuntimeTypes.sha256(sha256, "sha256");
    }
  }

  public record RuntimeRequirement(
      String requirementId,
      String kind,
      String displayName,
      String status,
      List<String> requiredFor,
      String installStrategy,
      String detail,
      RuntimeArtifactDescriptor artifact) {
    public RuntimeRequirement {
      requirementId = text(requirementId, "requirementId");
      kind = text(kind, "kind");
      displayName = text(displayName, "displayName");
      status = text(status, "status");
      requiredFor = requiredFor == null ? List.of() : List.copyOf(requiredFor);
      installStrategy = text(installStrategy, "installStrategy");
    }
  }
  public record RuntimeRequirements(List<RuntimeRequirement> items) { public RuntimeRequirements { items = items == null ? List.of() : List.copyOf(items); } }
  public record RuntimeModelOption(
      String optionId,
      String displayName,
      String modelReference,
      String expectedDigest,
      Long expectedBytes,
      String profileId,
      String profileSpecSha256,
      String status) {
    public RuntimeModelOption {
      optionId = text(optionId, "optionId");
      displayName = text(displayName, "displayName");
      modelReference = text(modelReference, "modelReference");
      expectedDigest =
          expectedDigest == null
              ? null
              : CaptureRuntimeTypes.sha256(expectedDigest, "expectedDigest");
      if (expectedBytes != null && expectedBytes < 1)
        throw new IllegalArgumentException("expectedBytes must be positive");
      profileId = text(profileId, "profileId");
      profileSpecSha256 = CaptureRuntimeTypes.sha256(profileSpecSha256, "profileSpecSha256");
      status = text(status, "status");
    }
  }
  public record RuntimeModelOptions(String catalogSha256, List<RuntimeModelOption> items) { public RuntimeModelOptions { items = items == null ? List.of() : List.copyOf(items); } }
  public record RuntimeInstallation(
      String installationId,
      String requirementId,
      String status,
      Double progress,
      Failure error,
      String createdAt,
      String updatedAt,
      String completedAt) {
    public RuntimeInstallation {
      installationId = text(installationId, "installationId");
      requirementId = text(requirementId, "requirementId");
      status = text(status, "status");
      CaptureRuntimeTypes.progress(progress);
      createdAt = timestamp(createdAt, "createdAt");
      updatedAt = timestamp(updatedAt, "updatedAt");
      completedAt = completedAt == null ? null : timestamp(completedAt, "completedAt");
    }
  }
  public record RuntimeInstallations(List<RuntimeInstallation> items) { public RuntimeInstallations { items = items == null ? List.of() : List.copyOf(items); } }

  public record RuntimeModelInstallation(
      String installationId,
      String optionId,
      String status,
      Double progress,
      Failure error,
      String createdAt,
      String updatedAt,
      String completedAt) {
    public RuntimeModelInstallation {
      installationId = text(installationId, "installationId");
      optionId = text(optionId, "optionId");
      status = text(status, "status");
      CaptureRuntimeTypes.progress(progress);
      createdAt = timestamp(createdAt, "createdAt");
      updatedAt = timestamp(updatedAt, "updatedAt");
      completedAt = completedAt == null ? null : timestamp(completedAt, "completedAt");
    }
  }

  public record RuntimeReady(
      boolean ready,
      String service,
      String apiVersion,
      String runtimeVersion,
      String captureDocumentSchemaVersion,
      String captureDocumentSchemaSha256,
      String schemaSha256,
      String contractSetVersion,
      Map<String, Object> capabilities,
      String message) {
    public RuntimeReady {
      service = service == null ? "capture-runtime" : service;
      apiVersion = apiVersion == null ? API_VERSION : apiVersion;
      if (!API_VERSION.equals(apiVersion)) throw new IllegalArgumentException("apiVersion must equal 2.0");
      runtimeVersion = runtimeVersion == null ? "" : runtimeVersion;
      captureDocumentSchemaVersion = captureDocumentSchemaVersion == null ? "2" : captureDocumentSchemaVersion;
      if (!PROTOCOL_VERSION.equals(captureDocumentSchemaVersion)) throw new IllegalArgumentException("captureDocumentSchemaVersion must equal 2");
      contractSetVersion = contractSetVersion == null ? CONTRACT_SET_VERSION : contractSetVersion;
      if (!CONTRACT_SET_VERSION.equals(contractSetVersion)) throw new IllegalArgumentException("contractSetVersion must equal 2");
      capabilities = capabilities == null ? Map.of() : Collections.unmodifiableMap(new LinkedHashMap<>(capabilities));
    }
  }

  public record ErrorBody(String code, String message, String category, boolean retryable, Map<String, Object> details, List<Map<String, Object>> issues, String requestId) {
    public ErrorBody {
      code = text(code, "code");
      message = text(message, "message");
      category = category == null ? "unknown" : text(category, "category");
      details = details == null ? Map.of() : Collections.unmodifiableMap(new LinkedHashMap<>(details));
      issues = issues == null ? List.of() : List.copyOf(issues);
    }
  }
  public record ErrorEnvelope(ErrorBody error) { public ErrorEnvelope { Objects.requireNonNull(error, "error"); } }
}
