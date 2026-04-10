// seeders/01-users.js
const User = require('../models/User');
const bcrypt = require('bcryptjs');

const seedUsers = async () => {
  await User.bulkCreate([
    {
      email: 'admin@kigalibus.rw',
      password: await bcrypt.hash('Admin123!', 10),
      full_name: 'Jean Paul Habimana',
      phone_number: '+250788111222',
      role: 'admin'
    },
    {
      email: 'peter@kigalibus.rw',
      password: await bcrypt.hash('Company123!', 10),
      full_name: 'Peter Ndayishimiye',
      phone_number: '+250788333444',
      role: 'company_admin'
    },
    {
      email: 'emmanuel@volcano.rw',
      password: await bcrypt.hash('Company123!', 10),
      full_name: 'Emmanuel Uwimana',
      phone_number: '+250788555666',
      role: 'company_admin'
    },
    {
      email: 'jean@gorilla.rw',
      password: await bcrypt.hash('Company123!', 10),
      full_name: 'Jean Mugabo',
      phone_number: '+250788777888',
      role: 'company_admin'
    },
    {
      email: 'driver1@kigalibus.rw',
      password: await bcrypt.hash('Driver123!', 10),
      full_name: 'Eric Nshimiyimana',
      phone_number: '+250788999000',
      role: 'driver'
    },
    {
      email: 'driver2@kigalibus.rw',
      password: await bcrypt.hash('Driver123!', 10),
      full_name: 'Olivier Hategekimana',
      phone_number: '+250788111333',
      role: 'driver'
    },
    {
      email: 'driver3@volcano.rw',
      password: await bcrypt.hash('Driver123!', 10),
      full_name: 'Claude Niyonshuti',
      phone_number: '+250788222444',
      role: 'driver'
    },
    {
      email: 'alice@example.com',
      password: await bcrypt.hash('Commuter123!', 10),
      full_name: 'Alice Mukamana',
      phone_number: '+250788555777',
      role: 'commuter'
    },
    {
      email: 'john@example.com',
      password: await bcrypt.hash('Commuter123!', 10),
      full_name: 'John Niyomugabo',
      phone_number: '+250788666888',
      role: 'commuter'
    },
    {
      email: 'grace@example.com',
      password: await bcrypt.hash('Commuter123!', 10),
      full_name: 'Grace Umutesi',
      phone_number: '+250788777999',
      role: 'commuter'
    }
  ]);
  console.log('10 Users seeded');
};

seedUsers();