# Swift Ship Server

Express and MongoDB API for Swift Ship parcel booking, tracking, Firebase
authentication, and SSLCommerz sandbox payments.

## Getting started

1. Copy `.env.example` to `.env` and provide the required credentials.
2. Install dependencies with `npm install`.
3. Start the API with `npm run dev`.
4. Run unit tests with `npm test`.

The default API address is `http://localhost:5000`. The frontend origin must
match `FRONTEND_URL` (or the optional `CLIENT_URL`) for browser CORS requests.

## Architecture

```text
src/
├── app.js          Express construction and middleware ordering
├── index.js        Database connection and HTTP server startup
├── config/         Environment, MongoDB, and Firebase setup
├── controllers/    HTTP input/output and status-code decisions
├── middleware/     Authentication and shared Express middleware
├── models/         Mongoose persistence schemas
├── routes/         URL-to-controller mappings
├── services/       Reusable business and integration logic
└── utils/          Small stateless helpers
```

Request processing follows:

```text
route → middleware → controller → service/model → response
```

Routes should remain declarative. Put HTTP-specific decisions in controllers,
reusable business rules in services, and database structure in models.

## Payment safety

SSLCommerz is hard-coded to sandbox mode in
`src/services/payment.service.js`. Deploying with `NODE_ENV=production` does
not enable live payments. Payment callbacks are accepted without Firebase
authentication because SSLCommerz sends them directly, but successful payments
are marked paid only after server-to-server `val_id` validation.

The parcel form currently has no postcode fields. The sandbox integration uses
`1000` for the required customer and shipping postcodes; replace this with
collected address data if postcode fields are added later.

## API groups

- `/api/users` — authenticated user profile operations
- `/api/parcels` — quotes, booking, history, tracking, and deletion
- `/api/payment` — sandbox checkout initialization and callbacks
- `/` — health check

Errors are returned as `{ "error": "message" }`. Unexpected server errors are
logged internally and exposed to clients only as `Internal server error`.

## Tracking API

Tracking events and payments are stored in their own MongoDB collections. A
parcel no longer stores payment state or current tracking status.

- `GET /api/tracking/:trackingId` — public lookup for a tracking URL
- `GET /api/tracking?trackingId=SS-...` — public lookup for a search box
- `POST /api/tracking/:trackingId/events` — append an event (admin/rider token)
- `GET /api/payment/:parcelId` — read the authenticated owner's payment

The event request body accepts `status`, `location`, `message`, and an optional
ISO `eventTime`. Supported statuses are `pending`, `assigned`, `picked-up`,
`in-transit`, `out-for-delivery`, `delivered`, and `cancelled`.
