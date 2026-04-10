// seeders/02-companies.js
const Company = require('../models/Company');
const User = require('../models/User');

const seedCompanies = async () => {
  const admin = await User.findOne({ where: { email: 'admin@kigalibus.rw' } });
  const peter = await User.findOne({ where: { email: 'peter@kigalibus.rw' } });
  const emmanuel = await User.findOne({ where: { email: 'emmanuel@volcano.rw' } });
  const jean = await User.findOne({ where: { email: 'jean@gorilla.rw' } });

  await Company.bulkCreate([
    {
      owner_id: peter.id,
      name: 'Kigali Bus Express Ltd',
      email: 'info@kigalibus.rw',
      phone: '+250788123456',
      address: 'KG 541 St, Kigali Heights, Kigali',
      country: 'Rwanda',
      status: 'approved',
      is_approved: true,
      approved_by: admin.id,
      subscription_status: 'active',
      subscription_paid: true,
      plan: 'Enterprise'
    },
    {
      owner_id: emmanuel.id,
      name: 'Volcano Rides Rwanda',
      email: 'contact@volcanorides.rw',
      phone: '+250788654321',
      address: 'KN 82 St, Remera, Kigali',
      country: 'Rwanda',
      status: 'approved',
      is_approved: true,
      approved_by: admin.id,
      subscription_status: 'active',
      subscription_paid: true,
      plan: 'Growth'
    },
    {
      owner_id: jean.id,
      name: 'Gorilla Express Shuttle',
      email: 'hello@gorillaexpress.rw',
      phone: '+250788987654',
      address: 'Musanze District, Northern Province',
      country: 'Rwanda',
      status: 'pending',
      is_approved: false,
      subscription_status: 'pending_approval',
      plan: 'Starter'
    }
  ]);
  console.log('3 Companies seeded');
};

seedCompanies();