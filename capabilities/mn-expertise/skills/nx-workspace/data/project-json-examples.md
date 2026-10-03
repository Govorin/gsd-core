# Project.json Examples

## TypeScript Library (Domain)

```json
{
  "name": "catpod-domain",
  "$schema": "../../../node_modules/nx/schemas/project-schema.json",
  "sourceRoot": "libs/catpod/domain/src",
  "projectType": "library",
  "tags": ["scope:catpod", "type:domain", "lang:ts"],
  "targets": {
    "lint": {
      "executor": "@nx/linter:eslint",
      "options": {
        "lintFilePatterns": ["libs/catpod/domain/**/*.ts"]
      }
    },
    "test": {
      "executor": "@nx/vite:test",
      "options": {
        "passWithNoTests": true
      }
    },
    "format": {
      "executor": "nx:run-commands",
      "options": {
        "command": "bunx @biomejs/biome format --write libs/catpod/domain"
      }
    },
    "format-check": {
      "executor": "nx:run-commands",
      "options": {
        "command": "bunx @biomejs/biome check libs/catpod/domain"
      }
    }
  }
}
```

## TypeScript API Application

```json
{
  "name": "catpod-api",
  "$schema": "../../../node_modules/nx/schemas/project-schema.json",
  "sourceRoot": "apps/catpod/api/src",
  "projectType": "application",
  "tags": ["scope:catpod", "type:api", "lang:ts", "platform:server"],
  "targets": {
    "build": {
      "executor": "@nx/esbuild:esbuild",
      "options": {
        "outputPath": "dist/apps/catpod/api",
        "main": "apps/catpod/api/src/main.ts",
        "tsConfig": "apps/catpod/api/tsconfig.app.json",
        "bundle": true,
        "platform": "node",
        "format": ["cjs"]
      }
    },
    "serve": {
      "executor": "@nx/js:node",
      "options": {
        "buildTarget": "catpod-api:build",
        "watch": true
      }
    }
  }
}
```

## React UI Library

```json
{
  "name": "catpod-ui-react",
  "$schema": "../../../../node_modules/nx/schemas/project-schema.json",
  "sourceRoot": "libs/catpod/ui/react/src",
  "projectType": "library",
  "tags": ["scope:catpod", "type:ui", "lang:ts", "platform:web"],
  "targets": {
    "build": {
      "executor": "@nx/vite:build",
      "options": {
        "outputPath": "dist/libs/catpod/ui/react"
      }
    }
  }
}
```

## Python Application

```json
{
  "name": "trade-mind-prophet",
  "$schema": "../../../node_modules/nx/schemas/project-schema.json",
  "sourceRoot": "apps/trade-mind/prophet",
  "projectType": "application",
  "tags": ["scope:trade", "type:app", "lang:python", "platform:server"],
  "targets": {
    "serve": {
      "executor": "nx:run-commands",
      "options": {
        "command": "uv run streamlit run apps/trade-mind/prophet/app.py",
        "cwd": "apps/trade-mind/prophet"
      }
    },
    "test": {
      "executor": "nx:run-commands",
      "options": {
        "command": "uv run pytest tests/",
        "cwd": "apps/trade-mind/prophet"
      }
    },
    "lint": {
      "executor": "nx:run-commands",
      "options": {
        "command": "uv run ruff check .",
        "cwd": "apps/trade-mind/prophet"
      }
    }
  }
}
```
