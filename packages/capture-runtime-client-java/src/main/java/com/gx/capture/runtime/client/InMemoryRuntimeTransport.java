package com.gx.capture.runtime.client;

import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.function.Function;
import java.util.regex.Pattern;

/** Deterministic route adapter for SDK and consumer tests; no sockets or credentials involved. */
public final class InMemoryRuntimeTransport implements RuntimeTransport {
  private final List<Route> routes;

  public InMemoryRuntimeTransport(List<Route> routes) {
    this.routes = List.copyOf(Objects.requireNonNull(routes, "routes"));
  }

  public InMemoryRuntimeTransport() {
    this(List.of());
  }

  @Override
  public RuntimeResponse request(RuntimeRequest request) {
    return dispatch(request);
  }

  @Override
  public RuntimeResponse stream(RuntimeRequest request) {
    return dispatch(request);
  }

  private RuntimeResponse dispatch(RuntimeRequest request) {
    for (var route : routes) {
      if ((route.method() == null || route.method().equalsIgnoreCase(request.method()))
          && route.path().matcher(request.path()).matches()) {
        return route.handler().apply(request);
      }
    }
    var body =
        "{\"error\":{\"code\":\"not_found\",\"message\":\"Route not found.\"}}"
            .getBytes(java.nio.charset.StandardCharsets.UTF_8);
    return new RuntimeResponse(404, Map.of("Content-Type", List.of("application/json")), body);
  }

  public static Route route(
      String method, String path, Function<RuntimeRequest, RuntimeResponse> handler) {
    return new Route(method, Pattern.compile(Pattern.quote(path)), handler);
  }

  public static Route route(
      String method, Pattern path, Function<RuntimeRequest, RuntimeResponse> handler) {
    return new Route(method, path, handler);
  }

  public record Route(
      String method, Pattern path, Function<RuntimeRequest, RuntimeResponse> handler) {
    public Route {
      path = Objects.requireNonNull(path, "path");
      handler = Objects.requireNonNull(handler, "handler");
      method = method == null || method.isBlank() ? null : method.strip().toUpperCase();
    }
  }
}
