# shadcn/ui Component Reference

## Form Components

| Component | Use Case | Key Props |
|-----------|----------|-----------|
| Button | Actions, submit | variant, size, asChild |
| Input | Text entry | type, placeholder |
| Textarea | Multi-line | rows, resize |
| Select | Single choice | value, onValueChange |
| Checkbox | Boolean toggle | checked, onCheckedChange |
| RadioGroup | Single from many | value, onValueChange |
| Switch | On/off toggle | checked, onCheckedChange |
| Slider | Range value | value, onValueChange, min, max |
| Form | RHF integration | form, onSubmit |

## Layout Components

| Component | Use Case |
|-----------|----------|
| Card | Content container |
| Separator | Visual divider |
| ScrollArea | Custom scrollbar |
| ResizablePanelGroup | Resizable panels |
| Collapsible | Expandable section |
| Accordion | Multiple collapsibles |
| Tabs | Tabbed content |

## Overlay Components

| Component | Use Case |
|-----------|----------|
| Dialog | Modal content |
| AlertDialog | Confirm actions |
| Sheet | Side panel |
| Popover | Floating content |
| Tooltip | Hover hints |
| DropdownMenu | Action menu |
| ContextMenu | Right-click menu |
| Command | Command palette |

## Feedback Components

| Component | Use Case |
|-----------|----------|
| Alert | Inline messages |
| Toast/Sonner | Notifications |
| Progress | Loading bar |
| Skeleton | Loading placeholder |
| Badge | Status indicator |

## Display Components

| Component | Use Case |
|-----------|----------|
| Table | Data tables |
| DataTable | With sorting/filtering |
| Avatar | User images |
| AspectRatio | Image containers |
| Calendar | Date picker |
| Carousel | Image slider |
| Chart | Data visualization |

## Composition Patterns

### Card with Form
```tsx
<Card>
  <CardHeader>
    <CardTitle>Settings</CardTitle>
  </CardHeader>
  <CardContent>
    <Form {...form}>
      <FormField control={form.control} name="email" render={...} />
    </Form>
  </CardContent>
  <CardFooter>
    <Button type="submit">Save</Button>
  </CardFooter>
</Card>
```

### Dialog with Form
```tsx
<Dialog>
  <DialogTrigger asChild>
    <Button>Open</Button>
  </DialogTrigger>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Edit Profile</DialogTitle>
    </DialogHeader>
    <Form {...form}>...</Form>
    <DialogFooter>
      <Button type="submit">Save</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

### Command Palette
```tsx
<Command>
  <CommandInput placeholder="Search..." />
  <CommandList>
    <CommandEmpty>No results</CommandEmpty>
    <CommandGroup heading="Actions">
      <CommandItem onSelect={...}>Create new</CommandItem>
    </CommandGroup>
  </CommandList>
</Command>
```
