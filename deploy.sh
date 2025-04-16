#!/bin/bash

# Get server IP
export SERVER_IP="52.5.62.181"
echo "Detected server IP: $SERVER_IP"

# Set fixed secrets
export JWT_SECRET="growthbook-useryze"
export DB_PASSWORD="60mLxL5u3BsXCSfP"

# Set encryption key
export ENCRYPTION_KEY="d+awUdkUEDb+F1Ewjc4CTEQ54vbTYJ0vZ+BQXSWvz5A="

echo "Starting GrowthBook..."
docker-compose down
docker-compose up -d

echo "GrowthBook is now running at:"
echo "- App: http://$SERVER_IP:3000"
echo "- API: http://$SERVER_IP:3100"
echo ""
echo "IMPORTANT: Keep these secrets safe! They are needed if you ever need to redeploy:"
echo "JWT_SECRET: $JWT_SECRET"
echo "DB_PASSWORD: $DB_PASSWORD"
echo "ENCRYPTION_KEY: $ENCRYPTION_KEY"