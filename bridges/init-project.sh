#!/usr/bin/env bash
set -euo pipefail

# init-project.sh — 初始化项目集成
# Usage: init-project.sh <project-path> <project-name>

CPB_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=common.sh
source "$CPB_ROOT/bridges/common.sh"

PROJECT_PATH="${1:?Usage: init-project.sh <project-path> <project-name>}"
PROJECT_NAME="${2:?Usage: init-project.sh <project-path> <project-name>}"

# 转义项目名（只允许字母数字和连字符）
SAFE_NAME=$(echo "$PROJECT_NAME" | sed 's/[^a-zA-Z0-9-]/-/g' | sed 's/^-*//;s/-*$//' | head -c 64)
if [ "$SAFE_NAME" != "$PROJECT_NAME" ]; then
  echo "Warning: Project name sanitized: '$PROJECT_NAME' -> '$SAFE_NAME'"
  PROJECT_NAME="$SAFE_NAME"
fi

if [ ! -d "$PROJECT_PATH" ]; then
  echo -e "${RED}Error: '$PROJECT_PATH' does not exist${NC}" >&2
  exit 1
fi

WIKI_DIR="$CPB_ROOT/wiki/projects/$PROJECT_NAME"
if [ -d "$WIKI_DIR" ]; then
  echo -e "${RED}Error: '$PROJECT_NAME' already exists${NC}" >&2
  exit 1
fi

# 1. 从模板创建项目 Wiki
cp -r "$CPB_ROOT/wiki/projects/_template" "$WIKI_DIR"
mkdir -p "$WIKI_DIR/inbox" "$WIKI_DIR/outputs"
echo "Created: $WIKI_DIR"

# 1.5 Store project metadata (source path for cwd resolution)
echo "{\"sourcePath\":\"$PROJECT_PATH\",\"name\":\"$PROJECT_NAME\",\"initAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > "$WIKI_DIR/project.json"

# 2. 替换占位符
for f in context.md tasks.md decisions.md log.md; do
  [ -f "$WIKI_DIR/$f" ] && sed -i.bak "s/{项目名}/$PROJECT_NAME/g" "$WIKI_DIR/$f" && rm -f "$WIKI_DIR/$f.bak"
done

# 3. 自动检测写入 context.md
CTX="$WIKI_DIR/context.md"
echo "" >> "$CTX"

if [ -f "$PROJECT_PATH/package.json" ]; then
  PKG_NAME=$(PKG_FILE="$PROJECT_PATH/package.json" node -e "try{console.log(JSON.parse(require('fs').readFileSync(process.env.PKG_FILE,'utf8')).name||'unknown')}catch{console.log('unknown')}" 2>/dev/null)
  PKG_DESC=$(PKG_FILE="$PROJECT_PATH/package.json" node -e "try{console.log(JSON.parse(require('fs').readFileSync(process.env.PKG_FILE,'utf8')).description||'')}catch{console.log('')}" 2>/dev/null)
  echo "- **Package**: $PKG_NAME" >> "$CTX"
  [ -n "$PKG_DESC" ] && echo "- **Description**: $PKG_DESC" >> "$CTX"
fi

for pair in "tsconfig.json:TypeScript" "vue.config.js:Vue.js" "next.config.js:Next.js" \
  "vite.config.ts:Vite" "nuxt.config.ts:Nuxt" "Cargo.toml:Rust" "go.mod:Go" \
  "pubspec.yaml:Flutter" "uni.scss:uni-app"; do
  IFS=":" read -r file label <<< "$pair"
  [ -f "$PROJECT_PATH/$file" ] && echo "- **Detected**: $label" >> "$CTX"
done

# 4. 相对路径 symlink（可移植）
mkdir -p "$PROJECT_PATH/.omc/wiki"
if [ ! -L "$PROJECT_PATH/.omc/wiki/cpb" ]; then
  REL_PATH=$(WIKI_DIR="$WIKI_DIR" TARGET="$PROJECT_PATH/.omc/wiki" python3 -c \
    "import os.path; print(os.path.relpath(os.environ['WIKI_DIR'], os.environ['TARGET']))" 2>/dev/null \
    || echo "$WIKI_DIR")
  ln -s "$REL_PATH" "$PROJECT_PATH/.omc/wiki/cpb"
  echo "Symlink: $PROJECT_PATH/.omc/wiki/cpb -> $REL_PATH"
fi

# 5. CPB.md
cat > "$PROJECT_PATH/CPB.md" << EOF
# CodePatchbay Configuration
cpb:
  project: $PROJECT_NAME
  codex_agent: planner
  claude_agent: executor
  wiki_root: .omc/wiki/cpb/
  phases:
    plan: { agent: planner, model: auto }
    execute: { agent: executor, model: auto }
    verify: { agent: verifier, model: auto }
EOF

echo "Created: $PROJECT_PATH/CPB.md"
echo ""
echo "Project '$PROJECT_NAME' ready."
echo "Wiki: $WIKI_DIR"
echo ""
echo "Next: cpb plan $PROJECT_NAME \"<task>\""
