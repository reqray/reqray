# Security

Reqray runs inside other people's applications and records their requests, so
a hole here is a hole in every application that uses it.

## Reporting a vulnerability

Please do not open a public issue. Use **Security → Report a vulnerability**
on this repository (GitHub's private vulnerability reporting). You will get an
answer within a week.

Useful in a report: the package and version, what an attacker needs (network
position, a gate that is open, a header they control), and the smallest
request or script that shows it.

## What counts

- Recorded data reaching someone it should not: the panel or the collector
  answering without its gate or token, a secret that masking should have
  caught stored in the clear.
- Anything a recorded request can do to the person reading it: script in the
  panel, escape sequences in the CLI, a line injected into an exported script.
- Replay running where it is forbidden.
- The instrumentation crashing or stalling the host application.

## What does not

- The panel being readable by anyone who can reach it when it was configured
  with `gate: 'open'`. That is what the setting says.
- Secrets in fields the default mask list does not name. The list is in the
  README and is extensible; a default worth adding is a welcome issue.
