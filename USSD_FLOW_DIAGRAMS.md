# SafariTix USSD Flow Diagrams

## Complete User Journey Diagrams

### 1️⃣ Booking Flow (Happy Path)

```
┌─────────────────────────────────────────────┐
│  User Dials: *384*123#                      │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│  CON Welcome to SafariTix                   │
│  1. Book Ticket                             │
│  2. Cancel Ticket                           │
│  3. Check Bus Schedule                      │
└──────────────────┬──────────────────────────┘
                   │ User types: 1
                   ▼
┌─────────────────────────────────────────────┐
│  CON Choose destination:                    │
│  1. Kigali                                  │
│  2. Huye                                    │
│  3. Musanze                                 │
└──────────────────┬──────────────────────────┘
                   │ User types: 2
                   ▼
┌─────────────────────────────────────────────┐
│  CON Enter seat number (1-50):              │
└──────────────────┬──────────────────────────┘
                   │ User types: 15
                   ▼
┌─────────────────────────────────────────────┐
│  CON Confirm booking:                       │
│  Destination: Huye                          │
│  Seat: 15                                   │
│  Price: 2500 RWF                            │
│                                             │
│  1. Confirm                                 │
│  2. Cancel                                  │
└──────────────────┬──────────────────────────┘
                   │ User types: 1
                   ▼
┌─────────────────────────────────────────────┐
│  END Ticket booked to Huye.                 │
│  Seat: 15                                   │
│  Ticket ID: TKT1234567890                   │
│  Pay 2500 RWF at station.                   │
└─────────────────────────────────────────────┘
```

**USSD Input Sequence**: `""` → `"1"` → `"1*2"` → `"1*2*15"` → `"1*2*15*1"`

---

### 2️⃣ Cancellation Flow

```
┌─────────────────────────────────────────────┐
│  User Dials: *384*123#                      │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│  CON Welcome to SafariTix                   │
│  1. Book Ticket                             │
│  2. Cancel Ticket        ◄──────────        │
│  3. Check Bus Schedule                      │
└──────────────────┬──────────────────────────┘
                   │ User types: 2
                   ▼
┌─────────────────────────────────────────────┐
│  CON Enter ticket ID:                       │
└──────────────────┬──────────────────────────┘
                   │ User types: TKT123456
                   ▼
┌─────────────────────────────────────────────┐
│  CON Cancel ticket TKT123456?               │
│  1. Yes, cancel                             │
│  2. No, go back                             │
└──────────────────┬──────────────────────────┘
                   │ User types: 1
                   ▼
┌─────────────────────────────────────────────┐
│  END Ticket TKT123456 cancelled             │
│  successfully.                              │
└─────────────────────────────────────────────┘
```

**USSD Input Sequence**: `""` → `"2"` → `"2*TKT123456"` → `"2*TKT123456*1"`

---

### 3️⃣ Schedule Check Flow

```
┌─────────────────────────────────────────────┐
│  User Dials: *384*123#                      │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│  CON Welcome to SafariTix                   │
│  1. Book Ticket                             │
│  2. Cancel Ticket                           │
│  3. Check Bus Schedule   ◄──────────        │
└──────────────────┬──────────────────────────┘
                   │ User types: 3
                   ▼
┌─────────────────────────────────────────────┐
│  CON Enter route (e.g., Kigali-Huye):       │
│  Popular routes:                            │
│  1. Kigali-Huye                             │
│  2. Kigali-Musanze                          │
│  3. Huye-Kigali                             │
│  Or type custom route                       │
└──────────────────┬──────────────────────────┘
                   │ User types: 1
                   ▼
┌─────────────────────────────────────────────┐
│  CON Next buses for Kigali → Huye:          │
│                                             │
│  08:00 AM, 11:00 AM, 02:00 PM, 05:00 PM     │
│                                             │
│  Safe travels with SafariTix!               │
└─────────────────────────────────────────────┘
```

**USSD Input Sequence**: `""` → `"3"` → `"3*1"`

---

## Code Flow Diagram

### Request Processing Flow

```
┌────────────────────────────────────────────────────┐
│  Africa's Talking POST /api/ussd                   │
│  {                                                 │
│    sessionId: "ATUid_123",                         │
│    serviceCode: "*384*123#",                       │
│    phoneNumber: "+250788123456",                   │
│    text: "1*2*15"                                  │
│  }                                                 │
└──────────────────┬─────────────────────────────────┘
                   │
                   ▼
┌────────────────────────────────────────────────────┐
│  routes/ussd.js                                    │
│  router.post('/', ussdController.handleUSSD)       │
└──────────────────┬─────────────────────────────────┘
                   │
                   ▼
┌────────────────────────────────────────────────────┐
│  controllers/ussdController.js                     │
│  handleUSSD(req, res)                              │
└──────────────────┬─────────────────────────────────┘
                   │
                   ▼
┌────────────────────────────────────────────────────┐
│  Parse Input: text.split("*")                      │
│  Result: ["1", "2", "15"]                          │
│  Level: 3                                          │
└──────────────────┬─────────────────────────────────┘
                   │
        ┌──────────┴──────────┐
        │                     │
        ▼                     ▼
┌───────────────┐    ┌───────────────┐
│ userInputs[0] │    │     level     │
│  = "1"        │    │      = 3      │
│ (Book Ticket) │    │ (Seat number  │
│               │    │  entered)     │
└───────┬───────┘    └───────┬───────┘
        │                    │
        └────────┬───────────┘
                 │
                 ▼
┌────────────────────────────────────────────────────┐
│  handleBookingFlow(inputs, level)                  │
│  - inputs[1] = "2" (Destination: Huye)             │
│  - inputs[2] = "15" (Seat number)                  │
│  - level = 3 (Show confirmation page)              │
└──────────────────┬─────────────────────────────────┘
                   │
                   ▼
┌────────────────────────────────────────────────────┐
│  Generate Response:                                │
│  "CON Confirm booking:\n                           │
│   Destination: Huye\n                              │
│   Seat: 15\n                                       │
│   Price: 2500 RWF\n\n                              │
│   1. Confirm\n                                     │
│   2. Cancel"                                       │
└──────────────────┬─────────────────────────────────┘
                   │
                   ▼
┌────────────────────────────────────────────────────┐
│  res.set('Content-Type', 'text/plain')             │
│  res.send(response)                                │
└──────────────────┬─────────────────────────────────┘
                   │
                   ▼
┌────────────────────────────────────────────────────┐
│  Africa's Talking receives response                │
│  Displays on user's phone                          │
└────────────────────────────────────────────────────┘
```

---

## Input Parsing Logic

### How `text.split("*")` Works

```
Input: "1*2*15*1"

Step 1: Split by "*"
┌───────────────────────────────┐
│ text.split("*")               │
└──────────┬────────────────────┘
           │
           ▼
┌─────────────────────────────────────────┐
│ userInputs = ["1", "2", "15", "1"]      │
│                                         │
│ [0] = "1"  → Main menu choice           │
│ [1] = "2"  → Sub-menu choice            │
│ [2] = "15" → User input (seat)          │
│ [3] = "1"  → Confirmation                │
└─────────────────────────────────────────┘

Step 2: Determine Level
┌─────────────────────────────────────────┐
│ level = userInputs.length = 4           │
└─────────────────────────────────────────┘

Step 3: Route to Handler
┌─────────────────────────────────────────┐
│ if (userInputs[0] === "1")              │
│   → handleBookingFlow()                 │
│ else if (userInputs[0] === "2")         │
│   → handleCancellationFlow()            │
│ else if (userInputs[0] === "3")         │
│   → handleScheduleFlow()                │
└─────────────────────────────────────────┘

Step 4: Level-based Logic
┌─────────────────────────────────────────┐
│ In handleBookingFlow():                 │
│                                         │
│ if (level === 1)                        │
│   → Show destinations                   │
│ else if (level === 2)                   │
│   → Ask for seat number                 │
│ else if (level === 3)                   │
│   → Show confirmation                   │
│ else if (level === 4)                   │
│   → Process booking                     │
└─────────────────────────────────────────┘
```

---

## State Machine View

```
                    text = ""
                        │
                        ▼
        ┌───────────────────────────────┐
        │       MAIN MENU               │
        │  (Level 0)                    │
        └───┬───────────┬───────────┬───┘
            │           │           │
     Press 1│    Press 2│    Press 3│
            │           │           │
            ▼           ▼           ▼
  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
  │ BOOKING     │ │ CANCELLATION│ │ SCHEDULE    │
  │ (Level 1)   │ │ (Level 1)   │ │ (Level 1)   │
  └──────┬──────┘ └──────┬──────┘ └──────┬──────┘
         │               │               │
         ▼               ▼               ▼
  Select Dest.    Enter Ticket ID  Select Route
  (Level 2)       (Level 2)        (Level 2)
         │               │               │
         ▼               ▼               │
  Enter Seat      Confirm Cancel        │
  (Level 3)       (Level 3)             │
         │               │               │
         ▼               ▼               ▼
  Confirm Booking  [END] Cancel    [CON] Schedule
  (Level 4)             Success          Times
         │
         ▼
  [END] Booking
       Success
```

---

## Response Type Decision Tree

```
                USSD Handler
                     │
                     ▼
        ┌────────────────────────┐
        │  Need more input?      │
        └────────┬───────────┬───┘
                 │           │
            YES  │           │  NO
                 │           │
                 ▼           ▼
        ┌────────────┐  ┌────────────┐
        │  Return    │  │  Return    │
        │  "CON ..." │  │  "END ..." │
        │            │  │            │
        │  Session   │  │  Session   │
        │  continues │  │  ends      │
        └────────────┘  └────────────┘
```

### Examples:

**CON (Continue):**
- Main menu
- Destination selection
- Seat number prompt
- Confirmation prompt
- Schedule display (optional)

**END (End):**
- Booking confirmed
- Ticket cancelled
- Invalid input
- Error occurred
- Final schedule display (optional)

---

## Error Handling Flow

```
                User Input
                     │
                     ▼
        ┌────────────────────────┐
        │  Validate Input        │
        └────────┬───────────┬───┘
                 │           │
            VALID│           │INVALID
                 │           │
                 ▼           ▼
        ┌────────────┐  ┌────────────────────┐
        │  Process   │  │  "END Invalid      │
        │  Request   │  │   choice, please   │
        └────────────┘  │   try again."      │
                        └────────────────────┘
```

### Validation Points:

1. **Main menu choice**: Must be 1, 2, or 3
2. **Destination**: Must be 1, 2, or 3
3. **Seat number**: Must be digits, 1-50
4. **Confirmation**: Must be 1 or 2
5. **Ticket ID**: Must be alphanumeric, min 3 chars
6. **Route**: Must exist in schedules object

---

## Adding New Destinations (Flow)

```
BEFORE:
destinations = {
  '1': { name: 'Kigali', price: 1500 },
  '2': { name: 'Huye', price: 2500 },
  '3': { name: 'Musanze', price: 3000 }
}

Menu shows:
1. Kigali
2. Huye
3. Musanze

────────────────────────────────────

AFTER (Add Rubavu):
destinations = {
  '1': { name: 'Kigali', price: 1500 },
  '2': { name: 'Huye', price: 2500 },
  '3': { name: 'Musanze', price: 3000 },
  '4': { name: 'Rubavu', price: 3500 }  ◄── NEW
}

Menu shows:
1. Kigali
2. Huye
3. Musanze
4. Rubavu                               ◄── AUTO-ADDED

✅ No code changes needed in handlers!
```

---

## Testing Flow

```
                test-ussd.js
                     │
                     ▼
        ┌────────────────────────┐
        │  Check server health   │
        └────────────┬───────────┘
                     │
                     ▼
        ┌────────────────────────┐
        │  Run Test Suite:       │
        │  - Main Menu           │
        │  - Booking Flow        │
        │  - Cancellation        │
        │  - Schedule Check      │
        │  - Invalid Inputs      │
        └────────────┬───────────┘
                     │
                     ▼
        ┌────────────────────────┐
        │  For each test:        │
        │  1. Send POST request  │
        │  2. Validate response  │
        │  3. Check CON/END      │
        │  4. Log results        │
        └────────────┬───────────┘
                     │
                     ▼
        ┌────────────────────────┐
        │  Display summary       │
        │  ✓ All tests passed    │
        └────────────────────────┘
```

---

This visual guide helps understand:
- 📱 How users interact with the USSD menu
- 🔄 How the code processes requests
- 🎯 How input parsing works
- ⚡ How responses are generated
- ✅ How validation works
- 🧪 How testing is structured
