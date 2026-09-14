FROM rust:1.88.0-alpine3.22@sha256:9dfaae478ecd298b6b5a039e1f2cc4fc040fc818a2de9aa78fa714dea036574d AS document-converter-builder

WORKDIR /converter
ARG CARGO_BUILD_JOBS=2
ENV CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS}
RUN apk add --no-cache build-base
COPY tools/document-converter/ ./
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/converter/target \
    cargo build --locked --release --bin petrichor-doc-convert \
    && mkdir -p /out \
    && cp target/release/petrichor-doc-convert /out/petrichor-doc-convert \
    && strip /out/petrichor-doc-convert

FROM golang:1.26.6-alpine AS builder

WORKDIR /src

ARG GOPROXY=https://proxy.golang.org,direct
ARG GO_BUILD_PARALLELISM=1
ENV GOPROXY=${GOPROXY}
ENV GOFLAGS=-p=${GO_BUILD_PARALLELISM}

COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download

COPY . .
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/petrichor-api ./cmd/server \
    && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/petrichor-worker ./cmd/worker \
    && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/petrichor-migrate ./cmd/migrate

FROM alpine:3.22 AS runtime-base

# Poppler 只负责服务端 PDF 拆页/栅格化；prlimit 限制不可信文件的子进程资源。
# Noto/CJK 字体为未嵌入字体的文档提供渲染回退，不依赖宿主机字体。
RUN apk add --no-cache ca-certificates tzdata poppler-utils=25.04.0-r0 util-linux font-noto font-noto-cjk \
    && addgroup -S petrichor \
    && adduser -S -G petrichor petrichor \
    && mkdir -p /app /data \
    && chown -R petrichor:petrichor /app /data

WORKDIR /app

FROM runtime-base

COPY --from=document-converter-builder /out/petrichor-doc-convert /usr/local/bin/petrichor-doc-convert
COPY tools/document-converter/LICENSE tools/document-converter/THIRD_PARTY_NOTICES.md /usr/share/licenses/petrichor-doc-convert/
COPY tools/document-converter/licenses/ /usr/share/licenses/petrichor-doc-convert/dependencies/
COPY --from=builder --chown=petrichor:petrichor /out/petrichor-api ./petrichor-api
COPY --from=builder --chown=petrichor:petrichor /out/petrichor-worker ./petrichor-worker
COPY --from=builder --chown=petrichor:petrichor /out/petrichor-migrate ./petrichor-migrate
COPY --chown=petrichor:petrichor docker-entrypoint.sh ./docker-entrypoint.sh

USER petrichor
EXPOSE 8080

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["server"]
