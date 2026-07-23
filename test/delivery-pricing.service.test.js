import assert from 'node:assert/strict'
import test from 'node:test'
import { calculateDeliveryCharge } from '../src/services/delivery-pricing.service.js'

test('prices a document within the same city', () => {
  const quote = calculateDeliveryCharge({
    type: 'document',
    weight: 1,
    senderServiceCenter: 'Dhaka',
    receiverServiceCenter: 'Dhaka',
  })

  assert.equal(quote.deliveryCost, 50)
  assert.equal(quote.deliveryZone, 'Within City')
})

test('prices a document outside the sender city', () => {
  const quote = calculateDeliveryCharge({
    type: 'document',
    weight: 1,
    senderServiceCenter: 'Dhaka',
    receiverServiceCenter: 'Chattogram',
  })

  assert.equal(quote.deliveryCost, 80)
  assert.equal(quote.deliveryZone, 'Outside City/District')
})

test('adds extra-weight and outside-city charges to non-documents', () => {
  const quote = calculateDeliveryCharge({
    type: 'non-document',
    weight: 5,
    senderServiceCenter: 'Dhaka',
    receiverServiceCenter: 'Chattogram',
  })

  assert.equal(quote.deliveryCost, 190)
  assert.deepEqual(
    quote.costBreakdown.map(({ amount }) => amount),
    [130, 40, 20]
  )
})

test('normalizes missing weight to one kilogram', () => {
  const quote = calculateDeliveryCharge({
    type: 'non-document',
    weight: '',
    senderServiceCenter: 'Dhaka',
    receiverServiceCenter: 'Dhaka',
  })

  assert.equal(quote.deliveryCost, 80)
})
