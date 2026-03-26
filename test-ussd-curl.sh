#!/bin/bash

# SafariTix USSD Quick Test Script
# Tests the USSD endpoint using cURL
# 
# Usage: bash test-ussd-curl.sh
# Windows: Use Git Bash or WSL

BASE_URL="https://backend-v2-wjcs.onrender.com/api/$1/api/ussd"

echo "=========================================="
echo "SafariTix USSD cURL Test Script"
echo "Testing endpoint: $BASE_URL"
echo "=========================================="
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}Test 1: Main Menu${NC}"
echo "Input: (empty)"
curl -s -X POST $BASE_URL \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "TEST123",
    "serviceCode": "*384*123#",
    "phoneNumber": "+250788123456",
    "text": ""
  }'
echo -e "\n"

echo -e "${BLUE}Test 2: Select Book Ticket${NC}"
echo "Input: 1"
curl -s -X POST $BASE_URL \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "TEST123",
    "serviceCode": "*384*123#",
    "phoneNumber": "+250788123456",
    "text": "1"
  }'
echo -e "\n"

echo -e "${BLUE}Test 3: Select Destination (Huye)${NC}"
echo "Input: 1*2"
curl -s -X POST $BASE_URL \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "TEST123",
    "serviceCode": "*384*123#",
    "phoneNumber": "+250788123456",
    "text": "1*2"
  }'
echo -e "\n"

echo -e "${BLUE}Test 4: Enter Seat Number${NC}"
echo "Input: 1*2*15"
curl -s -X POST $BASE_URL \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "TEST123",
    "serviceCode": "*384*123#",
    "phoneNumber": "+250788123456",
    "text": "1*2*15"
  }'
echo -e "\n"

echo -e "${BLUE}Test 5: Confirm Booking${NC}"
echo "Input: 1*2*15*1"
curl -s -X POST $BASE_URL \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "TEST123",
    "serviceCode": "*384*123#",
    "phoneNumber": "+250788123456",
    "text": "1*2*15*1"
  }'
echo -e "\n"

echo -e "${BLUE}Test 6: Cancel Ticket Flow${NC}"
echo "Input: 2"
curl -s -X POST $BASE_URL \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "TEST456",
    "serviceCode": "*384*123#",
    "phoneNumber": "+250788123456",
    "text": "2"
  }'
echo -e "\n"

echo -e "${BLUE}Test 7: Enter Ticket ID${NC}"
echo "Input: 2*TKT123456"
curl -s -X POST $BASE_URL \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "TEST456",
    "serviceCode": "*384*123#",
    "phoneNumber": "+250788123456",
    "text": "2*TKT123456"
  }'
echo -e "\n"

echo -e "${BLUE}Test 8: Check Schedule${NC}"
echo "Input: 3"
curl -s -X POST $BASE_URL \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "TEST789",
    "serviceCode": "*384*123#",
    "phoneNumber": "+250788123456",
    "text": "3"
  }'
echo -e "\n"

echo -e "${BLUE}Test 9: Select Route${NC}"
echo "Input: 3*1"
curl -s -X POST $BASE_URL \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "TEST789",
    "serviceCode": "*384*123#",
    "phoneNumber": "+250788123456",
    "text": "3*1"
  }'
echo -e "\n"

echo -e "${BLUE}Test 10: Invalid Input${NC}"
echo "Input: 9"
curl -s -X POST $BASE_URL \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "TEST999",
    "serviceCode": "*384*123#",
    "phoneNumber": "+250788123456",
    "text": "9"
  }'
echo -e "\n"

echo "=========================================="
echo -e "${GREEN}All tests completed!${NC}"
echo "=========================================="
