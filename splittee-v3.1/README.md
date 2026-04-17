# Split Tee v2.1

**Embeddable golf payment splitting platform with Stripe Connect**

Split Tee allows golf courses to offer group payment splitting directly on their booking sites. Golfers can split tee time costs among their group, with a timed payment window ensuring everyone pays before confirmation.

## Features

- **Embeddable Widget**: Courses add a simple JavaScript snippet - no backend changes needed
- **API Mode**: Full API access for custom integrations
- **Stripe Connect**: Funds go directly to courses; we collect a convenience fee
- **Timed Payments**: 10-minute countdown ensures all players pay or automatic refunds
- **Dual Payment Modes**: Auth holds for near-term bookings, immediate capture for future dates
- **Course Dashboard**: Real-time split tracking, transaction history, analytics
- **Webhooks**: Real-time notifications to course systems
- **Auto-Refunds**: Failed splits automatically refund all players

## Fee Structure

| Fee | Amount | Paid By |
|-----|--------|---------|
| Convenience Fee | 3% ($2 min, $5 max) | Each player |
| Platform Fee to Course | $0 | N/A |

Courses receive 100% of their tee time price. Players pay a small convenience fee.

## Quick Start

### Prerequisites

- Node.js 18+
- PostgreSQL database (Railway, Supabase, or Neon recommended)
- Stripe account with Connect enabled
- SendGrid account (for emails)
- Twilio account (optional, for SMS)

### Installation

```bash
# Clone the repository
git clone [your-repo-url]
cd splittee-v2.1

# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Edit .env with your credentials

# Set up database
npm run db:setup

# Start the server
npm start
```

### Environment Setup

See `.env.example` for all required environment variables. Key ones:

- `DATABASE_URL` - PostgreSQL connection string
- `STRIPE_SECRET_KEY` - Your Stripe secret key
- `STRIPE_PUBLISHABLE_KEY` - Your Stripe publishable key
- `JWT_SECRET` - Random 64+ character string
- `SMTP_*` - Email configuration (SendGrid recommended)

## Architecture

```
splittee-v2.1/
├── server.js           # Express server + API routes
├── db.js               # Database connection + models
├── schema.sql          # PostgreSQL schema
├── services/
│   ├── auth.js         # Authentication + JWT
│   ├── payments.js     # Stripe integration
│   ├── security.js     # Rate limiting, sanitization
│   ├── refunds.js      # Refund processing + retries
│   ├── webhooks.js     # Outbound webhooks to courses
│   └── notifications.js # Email + SMS
├── public/
│   ├── splittee.js     # Embeddable SDK
│   ├── pay.html        # Player payment page
│   ├── login.html      # Course login
│   ├── course-dashboard.html
│   ├── admin-dashboard.html
│   └── embed.html      # Integration demo
├── legal/
│   ├── terms.html
│   ├── privacy.html
│   ├── refund-policy.html
│   └── partner-agreement.html
└── package.json
```

## Integration Guide

### Simple Embed (Recommended)

Add to your booking page:

```html
<script src="https://your-domain.com/splittee.js"></script>
<script>
  SplitTee.init({
    courseId: 'YOUR_COURSE_ID',
    publicKey: 'YOUR_PUBLIC_KEY'
  });
</script>

<button onclick="SplitTee.createSplit({
  teeTime: '2025-03-15T08:30:00',
  totalPrice: 200,
  players: 4,
  courseName: 'Pine Valley Golf Club',
  bookingRef: 'BK-12345'
})">
  Split Payment with Group
</button>
```

### API Mode

For backend integrations:

```javascript
// Create a split
const response = await fetch('https://api.splittee.com/api/splits', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-SplitTee-Key': 'YOUR_API_KEY',
    'X-SplitTee-Signature': hmacSignature // optional
  },
  body: JSON.stringify({
    teeTime: '2025-03-15T08:30:00',
    totalPrice: 200,
    players: 4,
    courseName: 'Pine Valley Golf Club',
    bookingRef: 'BK-12345',
    bookerEmail: 'john@example.com',
    bookerName: 'John Smith',
    bookerPhone: '+15551234567' // optional
  })
});

const { splitId, shortCode, paymentUrl, expiresAt } = await response.json();
```

## API Reference

### Public Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/courses/:id/embed-info` | Get course info for embed |
| POST | `/api/calculate-price` | Calculate split pricing |
| POST | `/api/splits` | Create a new split |
| GET | `/api/pay/:token` | Get payment page data |
| POST | `/api/pay/:token/intent` | Create Stripe PaymentIntent |
| POST | `/api/pay/:token/confirm` | Confirm payment |

### Course Dashboard API

All require authentication via JWT or API key.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/course/profile` | Get course profile |
| GET | `/api/course/splits` | List splits (paginated) |
| GET | `/api/course/transactions` | List transactions |
| POST | `/api/course/api-keys` | Generate new API key |
| POST | `/api/course/webhooks` | Configure webhook URL |

### Webhooks

Configure your endpoint to receive:

- `split.created` - Split initiated
- `split.timer_started` - Countdown began
- `split.payment_received` - Player paid
- `split.fully_paid` - All players paid
- `split.expired` - Timer ran out
- `split.cancelled` - Booker cancelled
- `split.refunded` - Refunds processed

Payload example:
```json
{
  "event": "split.fully_paid",
  "splitId": "uuid",
  "shortCode": "ABC123",
  "bookingRef": "BK-12345",
  "totalAmount": 200,
  "players": [
    { "name": "John", "email": "john@example.com", "amount": 50, "status": "paid" }
  ],
  "timestamp": "2025-03-15T08:00:00Z"
}
```

Verify webhooks using the `X-SplitTee-Signature` header (HMAC-SHA256).

## Payment Flow

```
1. Golfer clicks "Split Payment" on course site
           ↓
2. Modal opens, golfer enters buddy emails
           ↓
3. Split created, links sent via email/SMS
           ↓
4. 10-minute countdown starts
           ↓
5a. All pay → Booking confirmed, course notified
5b. Timer expires → All payments auto-refunded
```

## Security

- All API endpoints rate-limited
- Input sanitization on all user data
- HMAC signature verification for webhooks
- bcrypt password hashing (12 rounds)
- JWT with refresh token rotation
- Stripe handles all payment card data (PCI compliant)
- CORS configured per-course

## Database

Uses PostgreSQL. Key tables:

- `courses` - Partner golf courses
- `course_sessions` - Auth sessions
- `splits` - Payment split records
- `players` - Individual players in splits
- `transactions` - Stripe payment records
- `refunds` - Refund tracking
- `webhook_deliveries` - Outbound webhook log

Run `npm run db:setup` to initialize.

## Scheduled Jobs

The server runs these automatically:

- **Every 1 min**: Check for expired splits, trigger refunds
- **Every 5 min**: Retry failed refunds
- **Every 2 min**: Retry failed webhook deliveries

## Deployment

### Railway (Recommended)

1. Create new project
2. Add PostgreSQL service
3. Connect your repo
4. Set environment variables
5. Deploy

### Manual

```bash
# Production
NODE_ENV=production npm start

# With PM2
pm2 start server.js --name splittee
```

### DNS / Cloudflare

1. Point your domain to your server
2. Enable SSL (required for Stripe)
3. Configure CORS_ORIGINS in .env

## Support

- **Courses**: partners@splittee.com
- **Players**: support@splittee.com
- **Technical**: dev@splittee.com

## License

Proprietary - Dorn Ventures LLC. All rights reserved.
