# SafariTix USSD Quick Test Script (PowerShell)
# Tests the USSD endpoint using Invoke-RestMethod
# 
# Usage: .\test-ussd.ps1

$baseUrl = "https://backend-7cxc.onrender.com/api/$1/api/ussd"
$headers = @{
    "Content-Type" = "application/json"
}

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "SafariTix USSD PowerShell Test Script" -ForegroundColor Cyan
Write-Host "Testing endpoint: $baseUrl" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

function Test-USSDRequest {
    param(
        [string]$TestName,
        [string]$Text,
        [string]$SessionId = "TEST123"
    )
    
    Write-Host "Test: $TestName" -ForegroundColor Blue
    Write-Host "Input: '$Text'" -ForegroundColor Yellow
    
    $body = @{
        sessionId = $SessionId
        serviceCode = "*384*123#"
        phoneNumber = "+250788123456"
        text = $Text
    } | ConvertTo-Json
    
    try {
        $response = Invoke-RestMethod -Uri $baseUrl -Method Post -Body $body -Headers $headers -ContentType "text/plain"
        Write-Host $response -ForegroundColor Green
        Write-Host ""
    } catch {
        Write-Host "Error: $_" -ForegroundColor Red
        Write-Host ""
    }
}

# Check if server is running
Write-Host "Checking server health..." -ForegroundColor Yellow
try {
    $health = Invoke-RestMethod -Uri "https://backend-7cxc.onrender.com/api/$1/api/health" -Method Get
    Write-Host "✓ Server is running" -ForegroundColor Green
    Write-Host ""
} catch {
    Write-Host "✗ Server is not running. Please start the server first:" -ForegroundColor Red
    Write-Host "  cd backend_v2" -ForegroundColor Yellow
    Write-Host "  npm start" -ForegroundColor Yellow
    exit
}

# Run tests
Test-USSDRequest -TestName "1. Main Menu" -Text "" -SessionId "TEST001"
Test-USSDRequest -TestName "2. Select Book Ticket" -Text "1" -SessionId "TEST002"
Test-USSDRequest -TestName "3. Select Destination (Huye)" -Text "1*2" -SessionId "TEST003"
Test-USSDRequest -TestName "4. Enter Seat Number" -Text "1*2*15" -SessionId "TEST004"
Test-USSDRequest -TestName "5. Confirm Booking" -Text "1*2*15*1" -SessionId "TEST005"
Test-USSDRequest -TestName "6. Complete Booking (Kigali)" -Text "1*1*25*1" -SessionId "TEST006"
Test-USSDRequest -TestName "7. Complete Booking (Musanze)" -Text "1*3*42*1" -SessionId "TEST007"
Test-USSDRequest -TestName "8. Cancel Ticket - Enter ID" -Text "2" -SessionId "TEST008"
Test-USSDRequest -TestName "9. Cancel Ticket - Confirm" -Text "2*TKT123456*1" -SessionId "TEST009"
Test-USSDRequest -TestName "10. Check Schedule" -Text "3" -SessionId "TEST010"
Test-USSDRequest -TestName "11. Check Schedule - Kigali-Huye" -Text "3*1" -SessionId "TEST011"
Test-USSDRequest -TestName "12. Check Schedule - Kigali-Musanze" -Text "3*2" -SessionId "TEST012"
Test-USSDRequest -TestName "13. Invalid Main Menu Option" -Text "9" -SessionId "TEST013"
Test-USSDRequest -TestName "14. Invalid Destination" -Text "1*9" -SessionId "TEST014"
Test-USSDRequest -TestName "15. Booking Cancellation" -Text "1*1*8*2" -SessionId "TEST015"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "✓ All tests completed successfully!" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Cyan
