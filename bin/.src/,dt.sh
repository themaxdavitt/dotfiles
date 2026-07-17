#!/usr/bin/env bash
set -e

# Why yes, future me, this _is_ RFC 3339 and ISO 8601 compliant: https://ijmacd.github.io/rfc3339-iso8601/
date -u +"%Y-%m-%dT%H:%M:%SZ"
