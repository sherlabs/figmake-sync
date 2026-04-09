# figmake-sync - New UX Architecture

## Overview
Complete redesign with **home screen + detail view** pattern and **tab-based navigation** within projects.

---

## User Flow

### 1. **Home Screen** (Project Selection)
```
┌─────────────────────────────────────────┐
│  figmake-sync                    Ready  │
├─────────────────────────────────────────┤
│  Projects              [+ New Project]  │
├─────────────────────────────────────────┤
│  ┌──────────┐  ┌──────────┐            │
│  │ Design   │  │ Marketing│            │
│  │ System   │  │ Site     │            │
│  │ Linked   │  │ Unlinked │            │
│  │ ~/proj.. │  │ ~/mark.. │            │
│  │ 2h ago   │  │ Never    │            │
│  └──────────┘  └──────────┘            │
└─────────────────────────────────────────┘
```

**Features:**
- Grid of project cards (responsive: 280px min-width)
- Each card shows: name, status badge, path, last sync
- Hover effects with elevation
- Delete button (× appears on hover)
- Click card to open project detail

---

### 2. **Project Detail View** (Tab-Based)
```
┌─────────────────────────────────────────┐
│  [← Projects]  Design System    Linked  │
├─────────────────────────────────────────┤
│  [Overview] [Changes] [Logs] [Output]   │
│           [Settings]                     │
├─────────────────────────────────────────┤
│  Tab Content Here                        │
│  • Overview: Setup + Quick Actions       │
│  • Changes: Diff summary                 │
│  • Logs: Activity + Screenshots          │
│  • Output: Command results               │
│  • Settings: Options + All commands      │
└─────────────────────────────────────────┘
```

---

## Tab Structure

### **Overview Tab**
- **Project Setup Panel**
  - Choose folder button
  - Figma URL input (if unlinked)
  - Metadata grid (last pull/push/verify)
- **Quick Actions Grid**
  - Large icon buttons for: Pull, Push, Sync, Status
  - Visual icons with labels
  - Hover effects with elevation

### **Changes Tab**
- **Diff Summary Panel**
  - Color-coded cards:
    - Green: Added files
    - Blue: Modified files
    - Red: Deleted files
    - Gray: Renamed files

### **Logs Tab**
- **Progress Panel**
  - Current operation status
  - Progress bar (determinate/indeterminate)
  - Live activity feed
- **Screenshot Panel** (conditional)
  - Shows Playwright failure screenshots
  - Image viewer with caption
  - Timestamp of error
  - Only visible when error occurs

### **Output Tab**
- **Result Panel**
  - JSON/text output from commands
  - Scrollable pre-formatted text
  - Syntax highlighting ready

### **Settings Tab**
- **Options Panel** (collapsible)
  - Dry run toggle
  - Verbose logs toggle
  - Prompt after uploads toggle
  - Pull strategy selector
- **All Commands Panel**
  - Authenticate
  - Verify
  - Install Browser

---

## Key UX Improvements

### **1. Clear Navigation Hierarchy**
```
Home → Select Project → View Tabs → Execute Actions
```

### **2. Context-Aware Tab Switching**
- Pull/Push/Sync → Auto-switch to **Logs** tab
- Errors → Auto-switch to **Output** tab (or **Logs** if screenshot)
- Status → Stay on current tab

### **3. Screenshot Detection**
When Playwright fails:
```typescript
// Error message contains: "screenshot saved to /path/to/error.png"
→ Parse screenshot path
→ Show screenshot panel in Logs tab
→ Display image with timestamp
→ Auto-switch to Logs tab
```

### **4. Visual Feedback**
- **Project Cards**: Hover elevation, border color change
- **Quick Actions**: Icon + label, hover lift effect
- **Tabs**: Active state with shadow
- **Buttons**: Scale animation on click

---

## Technical Architecture

### **State Management**
```typescript
interface AppState {
  projects: Map<string, ProjectState>
  activeProjectId: string | null
  activeTab: string  // "overview" | "changes" | "logs" | "output" | "settings"
  busy: boolean
  currentView: "home" | "detail"
}
```

### **Project State**
```typescript
interface ProjectState {
  id: string
  rootDir: string
  figmaMakeUrl: string
  linkedProject: ProjectInspection | null
  options: CommandOptions
  cardElement: HTMLElement  // Home screen card
  viewElement: HTMLElement  // Detail view content
}
```

### **View Switching**
```typescript
// Home → Detail
openProject(id) {
  homeScreen.hidden = true
  projectDetail.hidden = false
  renderProjectDetail(id)
}

// Detail → Home
showHome() {
  homeScreen.hidden = false
  projectDetail.hidden = true
}
```

### **Tab Switching**
```typescript
switchTab(name) {
  // Update tab button states
  tabs.forEach(t => t.classList.toggle("active", t.name === name))
  
  // Show/hide panels
  panels.forEach(p => p.hidden = p.name !== name)
}
```

---

## Screenshot Handling

### **Detection**
```typescript
function checkForScreenshot(project, error) {
  const errorMsg = error.message
  const match = errorMsg.match(/screenshot.*?([^\s]+\.png)/i)
  
  if (match) {
    const path = match[1]
    showScreenshot(path)
    switchTab("logs")
  }
}
```

### **Display**
```html
<section class="screenshot-panel" hidden>
  <div class="panel-head">
    <p class="panel-label">Error Screenshot</p>
    <h2>Playwright Failure</h2>
  </div>
  <div class="screenshot-viewer">
    <img src="file:///path/to/screenshot.png" />
    <p class="screenshot-caption">Error at: 4/9/2026, 11:00 PM</p>
  </div>
</section>
```

---

## Responsive Design

### **Desktop** (> 640px)
- Project grid: 3-4 columns
- Quick actions: 4 columns
- Full tab labels

### **Mobile** (≤ 640px)
- Project grid: 1-2 columns
- Quick actions: 2 columns
- Tabs scroll horizontally

---

## File Structure

```
src/electron/renderer/
├── index.html          # Home + Detail views, Templates
├── styles.css          # All styles including new components
└── app.ts             # State management, navigation, commands
```

---

## Benefits

✅ **No infinite scroll** - Tab-based organization
✅ **Clear project selection** - Visual grid on home screen
✅ **Focused workflows** - One tab per concern
✅ **Error visibility** - Screenshots shown in context
✅ **Quick actions** - Large, obvious buttons for common tasks
✅ **Progressive disclosure** - Advanced options in Settings tab
✅ **Persistent state** - Projects saved, last project restored
✅ **Modern aesthetics** - Clean, minimal, professional

---

## Future Enhancements

- **Search/Filter** projects on home screen
- **Project templates** for quick setup
- **Keyboard shortcuts** (Cmd+1-5 for tabs)
- **Drag-and-drop** folder selection
- **Real-time sync status** indicator
- **Screenshot gallery** for multiple errors
- **Export logs** functionality
