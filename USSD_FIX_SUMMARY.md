# USSD Booking Fix Summary

## Issue
When users selected "1. Book Ticket" in the USSD menu, they received:
```
END An error occurred. Please try again.
```

## Root Causes

### 1. SQL Datatype Mismatch 
**Problem**: The code used `CURRENT_TIME` to compare with `departure_time` column, but:
- `CURRENT_TIME` returns `TIME WITH TIME ZONE`
- Database column `departure_time` is actually `TIMESTAMP WITH TIME ZONE` (not `TIME` as Sequelize model suggested)
- PostgreSQL error: `operator does not exist: timestamp with time zone > time with time zone`

**Solution**: Changed all `CURRENT_TIME` references to `NOW()` for proper timestamp comparison.

### 2. Wrong Column Reference
**Problem**: Query referenced `b.make` but the `buses` table has `b.model` instead.
- PostgreSQL error: `column b.make does not exist`

**Solution**: Changed `b.make` to `b.model` in the SQL query.

## Files Modified

### `services/ussdService.js`
```javascript
// BEFORE (Wrong)
AND s.departure_time > CURRENT_TIME  // ❌ Type mismatch
b.make,                               // ❌ Column doesn't exist

// AFTER (Fixed)
AND s.departure_time > NOW()         // ✅ Correct timestamp comparison
b.model,                              // ✅ Correct column name
```

**Modified in 2 places:**
1. `getActiveRoutes()` - Line ~94 (routes with future schedules)
2. `getSchedulesForRoute()` - Line ~154 (schedules for specific route)

## Testing

### Test Command
```powershell
# Kill old server
Get-Process -Name node | Stop-Process -Force

# Start server
cd X:\new_safaritix\backend_v2
$env:NODE_ENV='production'
node app.js

# Test USSD booking
$body = '{"sessionId":"TEST1","serviceCode":"*384#","phoneNumber":"+250788123456","text":"1"}'
Invoke-RestMethod -Uri http://localhost:5000/api/ussd -Method POST -Body $body -ContentType 'application/json'
```

### Test Results
```
✅ Main Menu - Works
✅ Select "1. Book Ticket" - Shows routes
✅ Select route - Shows schedules with:
   - Date (1 Mar)
   - Departure time (10:00)
   - Arrival time (12:00)
   - Price (RWF 1,876)
   - Available seats (30 seats)
```

## Date Fixed
February 26, 2026

## Impact
- USSD booking flow now works completely
- Only future schedules are shown (departure_time > NOW())
- Real-time seat availability is calculated correctly
- Users can proceed with booking process

## Notes
- Database column types differ from Sequelize model definitions
- `departure_time` and `arrival_time` are stored as full timestamps, not time-only
- Must use `NOW()` for timestamp comparisons in PostgreSQL
