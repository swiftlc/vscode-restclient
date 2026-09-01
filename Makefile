.PHONY: compile build install all clean watch

VSCE    ?= npx vsce
CODE    ?= code
VSIX    := $(shell ls *.vsix 2>/dev/null | head -1)

## compile — webpack 生产编译
compile:
	@echo "==> webpack production build"
	npm run vscode:prepublish

## build — 打包 .vsix
build: compile
	@echo "==> packaging vsix"
	$(VSCE) package

## install — 安装 .vsix 到 VS Code
install:
	@echo "==> installing vsix"
	$(CODE) --install-extension rest-client-0.26.0.vsix

## all — 编译 + 打包 + 安装
all: compile build install
	@echo "==> done. reload VS Code window to take effect."

## watch — webpack 开发模式，自动增量编译
watch:
	@echo "==> webpack dev watch"
	npm run watch

## clean — 清理编译产物
clean:
	rm -rf dist *.vsix
	@echo "==> cleaned"

## help — 显示可用目标
help:
	@echo "make compile   — webpack 生产编译"
	@echo "make build     — 打包 .vsix"
	@echo "make install   — 安装 .vsix 到 VS Code"
	@echo "make all       — 编译 + 打包 + 安装 (默认)"
	@echo "make watch     — webpack 开发监听模式"
	@echo "make clean     — 清理 dist/ 和 *.vsix"

.DEFAULT_GOAL := all
