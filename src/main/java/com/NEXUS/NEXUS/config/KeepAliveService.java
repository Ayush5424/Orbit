package com.NEXUS.NEXUS.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

/**
 * Service that periodically pings the public web service endpoint to prevent
 * Render free-tier from shutting down after 15 minutes of inactivity.
 */
@Service
public class KeepAliveService {

    private static final Logger log = LoggerFactory.getLogger(KeepAliveService.class);

    private final boolean enabled;
    private final String targetUrl;
    private final HttpClient httpClient;

    public KeepAliveService(
            @Value("${orbit.keepalive.enabled:true}") boolean enabled,
            @Value("${orbit.keepalive.url:${RENDER_EXTERNAL_URL:https://nexus-api-cbql.onrender.com}}") String targetUrl
    ) {
        this.enabled = enabled;
        this.targetUrl = sanitizeUrl(targetUrl);
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .build();
    }

    private String sanitizeUrl(String url) {
        if (url == null || url.isBlank()) {
            return "https://nexus-api-cbql.onrender.com";
        }
        String clean = url.trim();
        if (clean.endsWith("/")) {
            clean = clean.substring(0, clean.length() - 1);
        }
        return clean;
    }

    // Ping every 10 minutes (600,000 ms), with an initial delay of 1 minute after boot
    @Scheduled(fixedRateString = "${orbit.keepalive.interval-ms:600000}", initialDelay = 60000)
    public void pingSelf() {
        if (!enabled) {
            return;
        }

        if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
            return;
        }

        String healthEndpoint = targetUrl + "/actuator/health";

        try {
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(healthEndpoint))
                    .header("User-Agent", "Orbit-KeepAlive/1.0")
                    .timeout(Duration.ofSeconds(15))
                    .GET()
                    .build();

            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());

            if (response.statusCode() >= 200 && response.statusCode() < 400) {
                log.info("[Orbit KeepAlive] Successfully pinged {} - status: {} (Reset Render 15-min idle timer)",
                        healthEndpoint, response.statusCode());
            } else {
                log.warn("[Orbit KeepAlive] Pinged {} - unexpected status: {}", healthEndpoint, response.statusCode());
            }
        } catch (Exception e) {
            log.debug("[Orbit KeepAlive] Ping attempt to {} failed: {}", healthEndpoint, e.getMessage());
        }
    }
}
