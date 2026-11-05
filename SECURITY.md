# Security policy

## Supported versions

StrataGate is currently pre-1.0. Security fixes are applied to the latest release and the default branch.

## Reporting a vulnerability

Do not open a public issue containing credentials, private conversations, raw provider traces, or an exploit that exposes stored memory. GitHub private vulnerability reporting is temporarily unavailable. Until it is restored, contact the maintainer directly at **jiahongcheng61@gmail.com** with a concise report. Do not attach production databases, raw memory transcripts, credentials, or tokens.

Include the affected version or commit, a minimal reproduction, expected impact, and any suggested mitigation.

## Memory-data safety

Applications integrating StrataGate should treat raw L5 transcripts and tool traces as sensitive data. Encrypt production storage, restrict access by tenant and agent, redact provider logs, and implement an explicit irreversible-deletion path when required by policy or law. The reference in-memory store is for integration and invariant testing, not a production security boundary.
