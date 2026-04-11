// seeders/08-payments.js
const Payment = require('../models/Payment');
const Ticket = require('../models/Ticket');

const seedPayments = async () => {
  const tickets = await Ticket.findAll();
  
  for (let i = 0; i < tickets.length; i++) {
    const ticket = tickets[i];
    const transactionRef = `MTN-${Date.now()}-${i + 1}`;
    
    await Payment.create({
      user_id: ticket.passenger_id,
      schedule_id: ticket.schedule_id,
      payment_method: 'mobile_money',
      phone_or_card: '+250788555777', // Example phone number
      amount: ticket.price,
      status: 'completed',
      booking_status: 'payment_confirmed',
      transaction_ref: transactionRef,
      provider_name: 'MTN Rwanda',
      provider_reference: `PROV-${Date.now()}-${i + 1}`,
      provider_status: 'SUCCESS',
      currency: 'RWF',
      seat_lock_ids: [],
      held_ticket_ids: [ticket.id],
      seat_numbers: [ticket.seat_number],
      meta: {
        payment_channel: 'USSD',
        customer_note: 'Payment for bus ticket'
      },
      completed_at: new Date()
    });
    
    // Update ticket with payment_id
    await ticket.update({ payment_id: (await Payment.findOne({ where: { transaction_ref: transactionRef } })).id });
  }
  
  console.log(`${tickets.length} Payments seeded`);
  console.log('Tickets updated with payment_ids');
};

seedPayments();