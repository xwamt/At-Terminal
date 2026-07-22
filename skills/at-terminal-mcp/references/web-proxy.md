# Web Proxy and Gateway Diagnosis

Read this reference for Nginx, Apache HTTP Server, reverse-proxy, gateway, redirect, virtual-host, upstream, HTTP 4xx/5xx, or TLS termination symptoms. For configuration changes or reloads, also read [safe operations](safe-operations.md).

## First-pass read-only checks

Identify the actual proxy and configuration source before running product-specific commands. Inspect process, listeners, service status, bounded error/access logs, effective configuration where supported, certificate metadata, and the upstream directly.

```sh
# Purpose: compare the external proxy response with the local upstream response
curl --connect-timeout 5 --max-time 15 -vI https://example.com/; curl --connect-timeout 5 --max-time 15 -vI http://127.0.0.1:<upstream-port>/health
```

Use `nginx -T`/`nginx -t` or `apachectl -S`/`apachectl configtest` only after confirming the installed product and command behavior. Effective-config output may contain sensitive paths or values; return only relevant excerpts.

## Decision path

- **No listener:** inspect service state, bind address, port conflict, privilege/capability, and configuration validation.
- **Wrong virtual host:** verify Host/SNI, listen address, server-name precedence, default site, and included configuration order.
- **502/503:** test the upstream directly; check Endpoint/port, socket permissions, DNS, connection pool, dependency health, and whether the upstream is restarting.
- **504/timeout:** locate which timeout fired, measure upstream latency, inspect saturation and downstream calls; do not simply raise timeouts.
- **Redirect loop:** trace scheme/host headers, trusted proxy settings, forwarded headers, application canonical URL, and each redirect hop.
- **TLS error:** inspect SNI, certificate chain, SAN, validity, key/certificate pairing metadata, protocol and clock; use [network/DNS/TLS](network-dns-tls.md).
- **Intermittent failure:** correlate a request ID across load balancer, proxy and upstream logs; compare backend instances and configuration versions.
- **Large request/response failure:** identify the exact layer enforcing size, buffering, header, or timeout limits before changing it.

## Escalation and changes

Back up the authoritative configuration, validate syntax, identify reload semantics and rollback commands, then obtain approval under Safe Operations. A successful config test does not authorize reload. Avoid exposing a previously private listener while fixing connectivity.

## Verification

Verify syntax, effective route, external and direct upstream health, TLS chain/hostname, representative status/body, headers, logs, latency, and multiple backends where applicable.

Official references: [Nginx command-line parameters](https://nginx.org/en/docs/switches.html), [Apache configuration files](https://httpd.apache.org/docs/current/configuring.html).
