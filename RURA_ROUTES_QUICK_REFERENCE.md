# RURA Routes Fix - Quick Reference Guide

## Overview
Fixed the SafariTix admin dashboard to ensure ALL rura_routes are fetched correctly, regardless of insertion method.

## Key Changes

### 1. Backend API Enhancement
**File**: `backend_v2/controllers/ruraRoutesController.js`

**New Query Parameter**:
```javascript
GET /api/routes?applicable_only=true
```

**What it does**:
- Filters for `status = 'active'` AND `effective_date <= today`
- Shows only currently applicable routes
- Overrides individual status/date filters when enabled

**Example Responses**:

```javascript
// With applicable_only=true
GET /api/routes?applicable_only=true&page=1&limit=50

Response:
{
  "success": true,
  "routes": [
    {
      "id": 1,
      "from_location": "Kigali",
      "to_location": "Huye",
      "price": 2500,
      "effective_date": "2026-01-01",
      "source_document": "RURA Notice 2026/01",
      "status": "active",
      "created_at": "2026-02-15T10:30:00Z"
    },
    // ... more routes
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 150,
    "totalPages": 3
  },
  "filters": {
    "applicableOnly": true,
    "status": "active",
    "effectiveDate": "on or before today"
  }
}
```

```javascript
// Without filters (show ALL routes)
GET /api/routes?page=1&limit=50

Response:
{
  "success": true,
  "routes": [
    // All routes including inactive and future-dated
  ],
  "pagination": {...},
  "filters": {
    "applicableOnly": false,
    "status": "all",
    "effectiveDate": "all"
  }
}
```

### 2. Frontend UI Updates
**File**: `project_safatiTix-developer/src/pages/admin/RuraRoutesManagement.tsx`

**New Features**:

#### A. "Applicable Only" Toggle
```tsx
<label className="flex items-center gap-2 cursor-pointer">
  <input
    type="checkbox"
    checked={applicableOnly}
    onChange={(e) => setApplicableOnly(e.target.checked)}
  />
  <span>Show Applicable Only (Active & Effective Today)</span>
</label>
```

#### B. Enhanced Sorting
All columns are now sortable by clicking the headers:
- From Location ✓
- To Location ✓
- Price ✓
- Effective Date ✓
- Status ✓

#### C. Smart Filter Disabling
When "Applicable Only" is checked:
- Status filter → Disabled (automatically set to 'active')
- Effective Date filter → Disabled (automatically set to '≤ today')
- Visual feedback with opacity and cursor changes

## Usage Examples

### For Admins

#### View Currently Applicable Routes (Default)
1. Open Admin Dashboard
2. Navigate to "RURA Routes" section
3. **By default**, you'll see routes that are:
   - Status = Active
   - Effective Date ≤ Today
4. ✓ This is what you want 90% of the time

#### View ALL Routes (Including Future/Inactive)
1. Uncheck "Show Applicable Only"
2. Now you can:
   - Select any status (Active/Inactive/All)
   - Filter by any effective date
   - See future-dated routes
   - See SQL-inserted routes
   - See form-inserted routes

#### Sort Routes
Click any column header to sort:
- **From Location**: Alphabetical (A→Z or Z→A)
- **To Location**: Alphabetical (A→Z or Z→A)
- **Price**: Lowest to highest or vice versa
- **Effective Date**: Oldest to newest or vice versa
- **Status**: Active first or Inactive first

#### Search Routes
Use the search box to find routes by:
- Origin location (e.g., "Kigali")
- Destination location (e.g., "Huye")
- Source document (e.g., "RURA Notice 2026/01")

### For Developers

#### Backend Query Logic
```javascript
// When applicable_only=true
WHERE status = 'active' 
  AND effective_date <= CURRENT_DATE

// When applicable_only=false and status=active
WHERE status = 'active'

// When applicable_only=false and no filters
WHERE 1=1  // Returns ALL routes
```

#### Frontend State Management
```typescript
const [applicableOnly, setApplicableOnly] = useState(true); // Default: show applicable only
const [statusFilter, setStatusFilter] = useState<'all'>('all'); // Default: all statuses
const [sortBy, setSortBy] = useState<SortField>('created_at'); // Default: newest first
const [sortOrder, setSortOrder] = useState<SortOrder>('desc');

// When fetching routes
const params = {
  page: 1,
  limit: 50,
  sortBy,
  sortOrder,
  ...(applicableOnly && { applicable_only: 'true' }),
  ...(search && { search }),
  ...(originFilter && { origin: originFilter }),
  ...(destinationFilter && { destination: destinationFilter }),
  ...(!applicableOnly && statusFilter !== 'all' && { status: statusFilter }),
};
```

## Data Flow

```
Admin UI
  ↓
[Applicable Only Toggle] = true (default)
  ↓
Frontend sends: GET /api/routes?applicable_only=true&page=1&limit=50
  ↓
Backend Controller
  ↓
WHERE status = 'active' AND effective_date <= CURRENT_DATE
  ↓
PostgreSQL Database
  ↓
Returns ALL matching routes (no discrimination by insertion method)
  ↓
Frontend displays results with pagination
```

## Verification Queries

### Check what routes exist in database:
```sql
-- All routes
SELECT 
  id, from_location, to_location, price, effective_date, 
  source_document, status, created_at 
FROM rura_routes 
ORDER BY created_at DESC;

-- Check for SQL-inserted vs form-inserted routes
-- (Both should appear - source_document is just for tracking)
SELECT 
  source_document, 
  COUNT(*) as count 
FROM rura_routes 
GROUP BY source_document;

-- Currently applicable routes (what admin sees by default)
SELECT * FROM rura_routes 
WHERE status = 'active' 
  AND effective_date <= CURRENT_DATE
ORDER BY created_at DESC;
```

## Common Issues & Solutions

### Issue: "I don't see my SQL-inserted routes"
**Solution**: Check these:
1. ✓ Is "Applicable Only" checked? If yes, are your routes active and effective?
2. ✓ Try unchecking "Applicable Only" to see ALL routes
3. ✓ Check the database directly with the SQL queries above

### Issue: "Sorting doesn't work"
**Solution**: 
1. ✓ Click the column header (they have hover effects)
2. ✓ Look for the arrow indicators (↑ or ↓)
3. ✓ First click = ascending, second click = descending

### Issue: "Filters are greyed out"
**Solution**: 
1. ✓ This is normal when "Applicable Only" is checked
2. ✓ Uncheck "Applicable Only" to use custom filters

## Migration Checklist

- [x] Backend updated to support `applicable_only` parameter
- [x] Frontend updated with new toggle and sorting
- [x] Default behavior: show applicable routes only
- [x] Option to view ALL routes (uncheck toggle)
- [x] Pagination maintained (50 per page)
- [x] Sorting by from_location and created_at working
- [x] No database schema changes required
- [x] Backward compatible API
- [x] Documentation created

## Testing Scenarios

### Scenario 1: Form-Inserted Route
```sql
INSERT INTO rura_routes (from_location, to_location, price, effective_date, source_document, status, created_at)
VALUES ('Kigali', 'Huye', 2500, '2026-01-01', 'Admin Form', 'active', NOW());
```
✓ Should appear in admin dashboard

### Scenario 2: SQL-Inserted Route
```sql
INSERT INTO rura_routes (from_location, to_location, price, effective_date, source_document, status, created_at)
VALUES ('Kigali', 'Gisenyi', 3000, '2026-02-01', 'RURA Notice 2026/02', 'active', NOW());
```
✓ Should appear in admin dashboard (same as form-inserted)

### Scenario 3: Future-Dated Route
```sql
INSERT INTO rura_routes (from_location, to_location, price, effective_date, source_document, status, created_at)
VALUES ('Kigali', 'Rubavu', 3200, '2027-01-01', 'Future Route', 'active', NOW());
```
✓ Should NOT appear when "Applicable Only" is checked
✓ Should appear when "Applicable Only" is unchecked

### Scenario 4: Inactive Route
```sql
INSERT INTO rura_routes (from_location, to_location, price, effective_date, source_document, status, created_at)
VALUES ('Kigali', 'Butare', 2400, '2025-01-01', 'Old Route', 'inactive', NOW());
```
✓ Should NOT appear when "Applicable Only" is checked
✓ Should appear when "Applicable Only" is unchecked and status filter = "All" or "Inactive"

## Summary

**Before**: Unclear what routes were shown, possibly missing some SQL-inserted routes
**After**: 
- ✓ All routes fetched regardless of insertion method
- ✓ Smart default: show applicable routes (active + effective today)
- ✓ Easy toggle to see ALL routes
- ✓ Full sorting capability on all major columns
- ✓ 50 routes per page pagination
- ✓ Clear visual feedback on active filters

**Result**: Admin dashboard now correctly shows ALL rura_routes with intelligent defaults.
