# shadcn/ui Implementation Patterns

## Monorepo Setup (NX)

### Shared UI Library Structure

```
libs/shared/ui/
├── src/
│   ├── components/
│   │   └── ui/           # shadcn components
│   │       ├── button.tsx
│   │       ├── card.tsx
│   │       └── index.ts
│   ├── lib/
│   │   └── utils.ts      # cn() helper
│   └── index.ts
├── components.json
├── tailwind.config.ts
└── project.json
```

### components.json for Monorepo

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "libs/shared/ui/tailwind.config.ts",
    "css": "libs/shared/ui/src/styles/globals.css",
    "baseColor": "neutral",
    "cssVariables": true
  },
  "aliases": {
    "components": "@workspace/shared/ui/components",
    "utils": "@workspace/shared/ui/lib/utils"
  }
}
```

## Form Validation (Framework-Agnostic)

### Validation Service

```ts
// libs/shared/validation/src/lib/form-validator.ts
import { z } from "zod"
import { Either, left, right } from "@sweet-monads/either"

export type ValidationError = {
  field: string
  message: string
}

export const createValidator = <T>(schema: z.ZodSchema<T>) => ({
  validate: (data: unknown): Either<ValidationError[], T> => {
    const result = schema.safeParse(data)
    if (result.success) return right(result.data)
    return left(result.error.errors.map(e => ({
      field: e.path.join("."),
      message: e.message
    })))
  }
})
```

### React Hook Adapter

```tsx
// libs/shared/ui/src/hooks/use-form-validation.ts
import { useState, useCallback } from "react"
import { createValidator, ValidationError } from "@workspace/shared/validation"
import { z } from "zod"

export function useFormValidation<T>(schema: z.ZodSchema<T>) {
  const [errors, setErrors] = useState<Record<string, string>>({})
  const validator = createValidator(schema)

  const validate = useCallback((data: unknown) => {
    return validator.validate(data).fold(
      errs => {
        setErrors(Object.fromEntries(errs.map(e => [e.field, e.message])))
        return null
      },
      validData => {
        setErrors({})
        return validData
      }
    )
  }, [])

  const clearErrors = useCallback(() => setErrors({}), [])

  return { errors, validate, clearErrors }
}
```

## Compound Components

### DataTable with Sorting/Filtering

```tsx
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table"

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[]
  data: TData[]
}

export function DataTable<TData, TValue>({ columns, data }: DataTableProps<TData, TValue>) {
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
  })

  return (
    <Table>
      <TableHeader>
        {table.getHeaderGroups().map(group => (
          <TableRow key={group.id}>
            {group.headers.map(header => (
              <TableHead key={header.id}>
                {flexRender(header.column.columnDef.header, header.getContext())}
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows.map(row => (
          <TableRow key={row.id}>
            {row.getVisibleCells().map(cell => (
              <TableCell key={cell.id}>
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
```

## Theme Switching

```tsx
// providers/theme-provider.tsx
"use client"
import { ThemeProvider as NextThemesProvider } from "next-themes"

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider attribute="class" defaultTheme="system" enableSystem>
      {children}
    </NextThemesProvider>
  )
}

// components/theme-toggle.tsx
"use client"
import { useTheme } from "next-themes"
import { Button } from "@/components/ui/button"
import { Moon, Sun } from "lucide-react"

export function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
    >
      <Sun className="h-5 w-5 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
      <Moon className="absolute h-5 w-5 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
    </Button>
  )
}
```

## Accessibility Checklist

- [ ] All interactive elements have focus states
- [ ] Color contrast meets WCAG AA (4.5:1 for text)
- [ ] Form fields have associated labels
- [ ] Error messages are announced to screen readers
- [ ] Dialogs trap focus and can be closed with Escape
- [ ] Loading states are communicated (`aria-busy`)
- [ ] Icons have `aria-hidden` or descriptive labels
