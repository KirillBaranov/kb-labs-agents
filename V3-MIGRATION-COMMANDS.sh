#!/bin/bash
# V3 Migration Commands for plugin-template
# Execute these commands step by step to migrate the plugin

set -e  # Exit on error

echo "🚀 V3 Migration Commands for kb-labs-plugin-template"
echo "=================================================="
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helper functions
info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

success() {
    echo -e "${GREEN}✅ $1${NC}"
}

warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

error() {
    echo -e "${RED}❌ $1${NC}"
}

# Check if we're in the right directory
if [ ! -f "V3-MIGRATION-PLAN.md" ]; then
    error "Not in plugin-template directory. Please cd to kb-labs-plugin-template/"
    exit 1
fi

echo "Step 0: Preparation"
echo "==================="
info "Current directory: $(pwd)"
info "Creating backup branch..."

# Uncomment to create backup branch
# git checkout -b v3-migration-plugin-template
# success "Backup branch created"

echo ""
echo "Step 1: Review Current State"
echo "============================"
info "Commands to migrate:"
ls -l packages/plugin-template-core/src/cli/commands/*.ts

echo ""
info "Current manifest files:"
ls -l packages/plugin-template-core/src/manifest*.ts

echo ""
echo "Step 2: Check Dependencies"
echo "=========================="
info "Current dependencies in package.json:"
cat packages/plugin-template-core/package.json | grep -A 10 '"dependencies"'

echo ""
echo "Step 3: Build Current State"
echo "==========================="
info "Building plugin-template-core..."
pnpm --filter @kb-labs/plugin-template-core run build
success "Build successful"

echo ""
echo "Step 4: Test Current Commands"
echo "============================="
warning "Test these commands manually:"
echo "  pnpm kb plugin-template:hello"
echo "  pnpm kb plugin-template:test-loader"
echo ""
read -p "Press Enter when ready to continue..."

echo ""
echo "Step 5: Migration Checklist"
echo "==========================="
echo ""
echo "📋 For EACH command, do the following:"
echo ""
echo "1. Open command file (e.g., run.ts)"
echo "2. Remove contract imports"
echo "3. Define types inline:"
echo "   interface MyFlags { ... }"
echo "   interface MyInput { argv: string[]; flags: MyFlags }"
echo "   interface MyResult { ... }"
echo ""
echo "4. Change handler format:"
echo "   FROM: async handler(ctx, argv, flags) { ... }"
echo "   TO:   handler: { async execute(ctx, input) { ... } }"
echo ""
echo "5. Update return value:"
echo "   FROM: return { ok: true, result }"
echo "   TO:   return { exitCode: 0, result }"
echo ""
echo "6. Export as default:"
echo "   FROM: export const run = defineCommand(...)"
echo "   TO:   export default defineCommand(...)"
echo ""
echo "7. Update manifest.v3.ts:"
echo "   - Add command entry"
echo "   - Set handler: './path/to/cmd.js#default'"
echo "   - Define flags with defineCommandFlags"
echo ""
echo "8. Build and test:"
echo "   pnpm --filter @kb-labs/plugin-template-core run build"
echo "   pnpm kb plugin-template:your-command --help"
echo "   pnpm kb plugin-template:your-command"
echo ""

read -p "Press Enter when all commands are migrated..."

echo ""
echo "Step 6: Cleanup V2 Files"
echo "========================"
warning "This will DELETE V2 files. Make sure everything is working!"
echo ""
echo "Files to remove:"
echo "  - packages/plugin-template-core/src/manifest.v2.ts"
echo "  - packages/plugin-template-core/src/cli/commands/flags.ts"
echo "  - packages/plugin-template-core/src/cli/commands/hello-v3.ts"
echo "  - packages/plugin-template-core/src/cli/commands/run.ts (if migrated to hello.ts)"
echo ""

read -p "Remove V2 files? (y/N) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    info "Removing V2 files..."

    # Uncomment these when ready
    # rm packages/plugin-template-core/src/manifest.v2.ts
    # rm packages/plugin-template-core/src/cli/commands/flags.ts
    # rm packages/plugin-template-core/src/cli/commands/hello-v3.ts

    success "V2 files removed (if uncommented)"
else
    warning "Skipped V2 file removal"
fi

echo ""
echo "Step 7: Update package.json"
echo "==========================="
warning "Remove contract dependencies from package.json"
echo ""
echo "Edit packages/plugin-template-core/package.json:"
echo "  REMOVE: \"@kb-labs/plugin-template-contracts\": \"workspace:*\""
echo "  REMOVE: \"@kb-labs/plugin-contracts\": \"workspace:*\" (if present)"
echo "  KEEP:   \"@kb-labs/sdk\": \"workspace:*\""
echo ""

read -p "Press Enter when package.json is updated..."

echo ""
echo "Step 8: Reinstall Dependencies"
echo "==============================="
info "Running pnpm install..."
pnpm install
success "Dependencies updated"

echo ""
echo "Step 9: Final Build"
echo "==================="
info "Building all packages..."
pnpm run build
success "Build successful"

echo ""
echo "Step 10: Final Testing"
echo "======================"
info "Testing all commands..."
echo ""
echo "Test these commands:"
echo "  pnpm kb plugin-template --help"
echo "  pnpm kb plugin-template:hello"
echo "  pnpm kb plugin-template:hello --name Developer"
echo "  pnpm kb plugin-template:hello --json"
echo "  pnpm kb plugin-template:test-loader"
echo "  pnpm kb plugin-template:test-loader --duration 1000 --stages 5"
echo ""

read -p "Press Enter when all tests pass..."

echo ""
echo "Step 11: Verify Plugin Registry"
echo "================================"
info "Checking plugin is registered..."
pnpm kb plugins list | grep "plugin-template" || error "Plugin not found in registry!"
success "Plugin found in registry"

echo ""
echo "Step 12: Update Documentation"
echo "============================="
info "Update these files if needed:"
echo "  - README.md (if command examples changed)"
echo "  - CHANGELOG.md (add migration entry)"
echo "  - V3-MIGRATION-SUMMARY.md (update status)"
echo ""

read -p "Press Enter when documentation is updated..."

echo ""
echo "Step 13: Commit Changes"
echo "======================="
warning "Review all changes before committing!"
echo ""
echo "Suggested commit message:"
echo "  feat(plugin-template): migrate to V3 plugin architecture"
echo ""
echo "  - Migrate all commands to V3 format"
echo "  - Remove V2 manifest and contracts"
echo "  - Update documentation"
echo "  - Add migration guides"
echo ""

read -p "Commit changes? (y/N) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    info "Staging changes..."
    # git add packages/plugin-template-core/src/
    # git add packages/plugin-template-core/package.json
    # git add V3-*.md
    # git add ../docs/V3-MIGRATION-GUIDE*.md

    info "Committing..."
    # git commit -m "feat(plugin-template): migrate to V3 plugin architecture"

    success "Changes committed (if uncommented)"
else
    warning "Skipped commit"
fi

echo ""
echo "✅ Migration Complete!"
echo "======================"
success "Plugin-template has been migrated to V3!"
echo ""
echo "Next steps:"
echo "  1. Test thoroughly in different scenarios"
echo "  2. Update any external documentation"
echo "  3. Use as reference for other plugin migrations"
echo "  4. Share migration guides with team"
echo ""
echo "Documentation created:"
echo "  - V3-MIGRATION-PLAN.md (detailed plan)"
echo "  - V3-QUICK-REFERENCE.md (cheat sheet)"
echo "  - V3-MIGRATION-SUMMARY.md (status overview)"
echo "  - V3-MIGRATION-COMMANDS.sh (this file)"
echo "  - ../docs/V3-MIGRATION-GUIDE.EN.md (English guide)"
echo ""
echo "Reference implementation:"
echo "  - packages/plugin-template-core/src/cli/commands/hello.ts"
echo "  - packages/plugin-template-core/src/manifest.v3.ts"
echo ""
echo "🎉 Happy coding!"
