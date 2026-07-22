# Network, DNS, and TLS Diagnosis

Read this reference for connection failures, timeouts, refused ports, route problems, DNS errors, packet loss, or TLS handshake and certificate symptoms. For network, firewall, DNS, proxy, or certificate changes, also read [safe operations](safe-operations.md).

## First-pass read-only checks

Resolve the path layer by layer: local listener → local route → name resolution → remote TCP reachability → TLS → application response.

```sh
# Purpose: inspect addresses, routes, listeners, resolver state, and bounded connectivity evidence
ip -brief address; ip route; ss -lntup; getent hosts example.com; curl --connect-timeout 5 --max-time 15 -vI https://example.com/
```

Do not send credentials in diagnostic requests. Use `ip route get <address>` for the selected route, `ss` for socket ownership, and `openssl s_client -connect host:443 -servername host -verify_return_error </dev/null` for a bounded TLS check when OpenSSL is available.

## Decision path

- **Connection refused:** the destination is reachable but nothing accepts that address/port, or an active reject occurs. Check binding and service state.
- **Timeout:** distinguish routing, firewall, packet loss, overloaded listener, and downstream application timeout. Avoid assuming firewall first.
- **Wrong bind address:** compare loopback, wildcard, IPv4, IPv6, container namespace, and advertised address.
- **DNS failure:** compare configured resolver behavior, search domains, returned records, TTL, and direct address connectivity. Do not edit `/etc/hosts` as a default fix.
- **Wrong route:** inspect source address, selected interface, policy routing, VPN, and namespace before changes.
- **TLS failure:** check SNI, hostname/SAN match, validity period, chain, trust store, protocol mismatch, and clock skew.
- **HTTP gateway error:** route to [web proxy](web-proxy.md) and verify the upstream independently.

## Escalation and changes

Firewall, route, interface, resolver, certificate, proxy, and security-group changes can sever access. Preserve the current configuration, identify an out-of-band recovery path, prepare rollback commands, and obtain explicit approval under Safe Operations.

## Verification

Repeat resolution, route, TCP, TLS, and application checks from the relevant network namespace and client perspective. Verify both direct upstream and end-user path, and confirm no unintended exposure was introduced.

Official references: [ip-route](https://man7.org/linux/man-pages/man8/ip-route.8.html), [OpenSSL s_client](https://docs.openssl.org/master/man1/openssl-s_client/).
