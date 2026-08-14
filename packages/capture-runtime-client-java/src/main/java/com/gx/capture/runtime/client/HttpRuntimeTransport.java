package com.gx.capture.runtime.client;

import java.io.IOException;
import java.net.InetAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.Objects;

/** Authenticated loopback HTTP transport for Capture Runtime. */
public final class HttpRuntimeTransport implements RuntimeTransport, AutoCloseable {
  private final URI baseUri;
  private final String bearerToken;
  private final HttpClient client;

  public HttpRuntimeTransport(String baseUrl, String bearerToken) {
    this(baseUrl, bearerToken, Duration.ofSeconds(30));
  }

  public HttpRuntimeTransport(String baseUrl, String bearerToken, Duration connectTimeout) {
    this.baseUri = validateLoopbackBaseUri(baseUrl);
    if (bearerToken == null
        || bearerToken.isBlank()
        || bearerToken.indexOf('\r') >= 0
        || bearerToken.indexOf('\n') >= 0) {
      throw new IllegalArgumentException("Capture Runtime bearer token must not be empty");
    }
    this.bearerToken = bearerToken.strip();
    this.client =
        HttpClient.newBuilder()
            .connectTimeout(Objects.requireNonNull(connectTimeout, "connectTimeout"))
            .followRedirects(HttpClient.Redirect.NEVER)
            .build();
  }

  @Override
  public RuntimeResponse request(RuntimeRequest request) throws IOException, InterruptedException {
    return send(request, HttpResponse.BodyHandlers.ofByteArray());
  }

  @Override
  public RuntimeResponse stream(RuntimeRequest request) throws IOException, InterruptedException {
    return send(request, HttpResponse.BodyHandlers.ofByteArray());
  }

  public URI baseUri() {
    return baseUri;
  }

  @Override
  public void close() {
    // java.net.http.HttpClient has no close operation; retained for try-with-resources symmetry.
  }

  private <T> RuntimeResponse send(RuntimeRequest request, HttpResponse.BodyHandler<T> bodyHandler)
      throws IOException, InterruptedException {
    var builder =
        HttpRequest.newBuilder(resolvePath(request.path()))
            .timeout(Duration.ofMinutes(10))
            .header(
                "Accept",
                request.headers().getOrDefault("Accept", List.of("application/json")).getFirst())
            .header("Authorization", "Bearer " + bearerToken);
    request
        .headers()
        .forEach(
            (name, values) -> {
              if (!name.equalsIgnoreCase("Authorization") && !name.equalsIgnoreCase("Host")) {
                values.forEach(value -> builder.header(name, value));
              }
            });
    var body = request.body();
    builder.method(
        request.method(),
        body.length == 0
            ? HttpRequest.BodyPublishers.noBody()
            : HttpRequest.BodyPublishers.ofByteArray(body));
    var response = client.send(builder.build(), bodyHandler);
    var headers = new java.util.LinkedHashMap<String, List<String>>();
    response.headers().map().forEach((name, values) -> headers.put(name, List.copyOf(values)));
    @SuppressWarnings("unchecked")
    var bytes =
        response.body() instanceof byte[] array
            ? array
            : ((String) response.body()).getBytes(java.nio.charset.StandardCharsets.UTF_8);
    return new RuntimeResponse(response.statusCode(), headers, bytes);
  }

  private URI resolvePath(String path) {
    if (path == null || !path.startsWith("/") || path.contains("\\") || path.contains("..")) {
      throw new CaptureTransportError("Capture Runtime request path is invalid.", null);
    }
    return baseUri.resolve(path);
  }

  public static URI validateLoopbackBaseUri(String value) {
    if (value == null || value.isBlank()) {
      throw new IllegalArgumentException("Capture Runtime URL is invalid.");
    }
    final URI uri;
    try {
      uri = URI.create(value.strip());
    } catch (IllegalArgumentException exception) {
      throw new IllegalArgumentException("Capture Runtime URL is invalid.", exception);
    }
    var host = uri.getHost();
    var loopback =
        host != null
            && (host.equalsIgnoreCase("localhost")
                || host.equals("127.0.0.1")
                || host.equals("[::1]")
                || host.equals("::1")
                || isLoopback(host));
    if (!"http".equalsIgnoreCase(uri.getScheme())
        || !loopback
        || uri.getPort() < 1
        || uri.getUserInfo() != null
        || uri.getQuery() != null
        || uri.getFragment() != null
        || !(uri.getPath() == null || uri.getPath().isEmpty() || uri.getPath().equals("/"))) {
      throw new IllegalArgumentException(
          "Capture Runtime URL must be an HTTP loopback origin with an explicit port.");
    }
    return URI.create(
        "http://"
            + (host.contains(":") ? "[" + host.replace("[", "").replace("]", "") + "]" : host)
            + ":"
            + uri.getPort());
  }

  private static boolean isLoopback(String host) {
    try {
      return InetAddress.getByName(host).isLoopbackAddress();
    } catch (Exception ignored) {
      return false;
    }
  }
}
