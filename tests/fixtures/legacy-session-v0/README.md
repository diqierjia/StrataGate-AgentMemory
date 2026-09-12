# Redacted DSH v0 fixture

This fixture preserves the envelope and event ordering of the affected legacy
sessions while replacing every workspace path, message, identifier, model name,
and citation value with deterministic test data. It intentionally places the
retired `stratagate/memory-citations` event between two complete turns so tests
can prove that content before and after the event survives migration unchanged.
