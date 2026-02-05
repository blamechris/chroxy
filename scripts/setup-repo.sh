#!/bin/bash
# Chroxy Repo Setup
# Run this after extracting chroxy.tar.gz

set -e

echo "🚀 Setting up Chroxy repo..."

# Initialize git
git init
git add .
git commit -m "Initial commit: Chroxy v0.1.0"

# Create GitHub repo and push
echo ""
echo "📦 Creating GitHub repo..."
gh repo create blamechris/chroxy --public --source=. --push

echo ""
echo "✅ Done! Your repo is live at:"
echo "   https://github.com/blamechris/chroxy"
echo ""
echo "Next steps:"
echo "   1. cd packages/server && npm install"
echo "   2. npx chroxy init"
echo "   3. npx chroxy start"
