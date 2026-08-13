.PHONY: generate run tidy test

generate:
	go generate ./ent

run:
	go run ./cmd/server

tidy:
	go mod tidy

test:
	go test ./...
