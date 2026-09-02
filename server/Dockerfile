# SPDX-License-Identifier: GPL-3.0-or-later
# Build context is the REPO ROOT, not server/: the image ships the Go binary
# AND the PWA it serves, and those live side by side.
#   docker build -f server/Dockerfile -t putzii-server .

FROM golang:1.27-alpine AS build
# The build context has no .git, so the binary cannot read its own commit:
# the caller stamps it. CI passes the SHA; docker-compose passes
# $PUTZII_VERSION. `putzii-server version` and the serve log echo it back.
ARG VERSION=dev
WORKDIR /src
# No third-party dependencies — go.mod alone is the whole dependency graph,
# so there is nothing to download and nothing to verify at build time.
COPY server/go.mod ./server/go.mod
COPY server/ ./server/
RUN CGO_ENABLED=0 go build -C server -trimpath -ldflags="-s -w -X main.version=${VERSION}" -o /out/putzii-server ./cmd/putzii-server

FROM alpine:3.22
# git only for the optional git_audit history; ca-certificates so an operator
# shelling in can reach the outside world. The server itself makes no
# outbound calls.
RUN apk add --no-cache ca-certificates git tzdata \
 && adduser -D -H -u 10001 putzii
WORKDIR /app
COPY --from=build /out/putzii-server /usr/local/bin/putzii-server
# The PWA, exactly as the repo has it — one UI, no second frontend.
COPY --chown=putzii:putzii \
     index.html c.html style.css print.css manifest.json favicon.svg robots.txt \
     service-worker.js sw-register.js qrcodegen.js \
     helpers.js store.js model.js share.js router.js app.js \
     ui-views.js ui-weeks.js ui-manage.js ui-share.js ui-checkin.js \
     dropcrypto.js drop.js sync.js self-check.js \
     /app/
# Berlin, pinned: ISO week keys differ across the date line (a Sunday 22:30
# UTC is already Monday in Berlin, i.e. the NEXT ISO week).
ENV TZ=Europe/Berlin
USER putzii
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/healthz || exit 1
ENTRYPOINT ["putzii-server"]
CMD ["serve", "--config", "/data/putzii-server.conf", "--app", "/app", "--listen", ":8080"]
