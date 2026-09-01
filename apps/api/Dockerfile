FROM golang:1.26.6-alpine AS builder

WORKDIR /src

ARG GOPROXY=https://proxy.golang.org,direct
ENV GOPROXY=${GOPROXY}

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/petrichor-api ./cmd/server \
    && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/petrichor-worker ./cmd/worker \
    && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/petrichor-migrate ./cmd/migrate

FROM alpine:3.22

RUN apk add --no-cache ca-certificates tzdata \
    && addgroup -S petrichor \
    && adduser -S -G petrichor petrichor \
    && mkdir -p /app /data \
    && chown -R petrichor:petrichor /app /data

WORKDIR /app

COPY --from=builder --chown=petrichor:petrichor /out/petrichor-api ./petrichor-api
COPY --from=builder --chown=petrichor:petrichor /out/petrichor-worker ./petrichor-worker
COPY --from=builder --chown=petrichor:petrichor /out/petrichor-migrate ./petrichor-migrate
COPY --chown=petrichor:petrichor docker-entrypoint.sh ./docker-entrypoint.sh

USER petrichor
EXPOSE 8080

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["server"]
