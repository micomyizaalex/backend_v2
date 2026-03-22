const { Sequelize } = require('sequelize');

const User = require('./User')
const Notification = require("./Notification")
const sequelize = require("../config/database");
const Company = require("./Company");
const Bus = require("./Bus");
const Driver = require("./Driver");
const DriverAssignment = require("./DriverAssignment");
const Journal = require("./Journal");
const Route = require("./Route");
const Schedule = require("./Schedule");
const Ticket = require("./Ticket");
const Location = require("./Location");
const Payment = require("./Payment");
const ScheduleJournal = require('./ScheduleJournal');
const Seat = require('./Seat');
const SeatLock = require('./SeatLock');
const LiveBusLocation = require('./LiveBusLocation');
const DriverLocation = require('./DriverLocation');

// ============================================
// RELATIONSHIPS / ASSOCIATIONS
// ============================================

// User relationships
User.hasMany(Company, { foreignKey: "owner_id", as: "ownedCompanies" });
User.hasMany(Company, { foreignKey: "approved_by", as: "approvedCompanies" });
User.hasMany(Driver, { foreignKey: "user_id" });
User.hasMany(DriverAssignment, { foreignKey: "assigned_by" });
User.hasMany(Schedule, { foreignKey: "created_by" });
User.hasMany(Ticket, { foreignKey: "passenger_id" });
User.hasMany(Notification, { foreignKey: "user_id" });
User.belongsTo(Company, { foreignKey: "company_id", as: "company" });

// Company relationships
Company.belongsTo(User, { foreignKey: "owner_id", as: "owner" });
Company.belongsTo(User, { foreignKey: "approved_by", as: "approver" });
Company.hasMany(Bus, { foreignKey: "company_id" });
Company.hasMany(Driver, { foreignKey: "company_id" });
Company.hasMany(DriverAssignment, { foreignKey: "company_id" });
Company.hasMany(Journal, { foreignKey: "company_id" });
Company.hasMany(Route, { foreignKey: "company_id" });
Company.hasMany(Schedule, { foreignKey: "company_id" });
Company.hasMany(Ticket, { foreignKey: "company_id" });
Company.hasMany(User, { foreignKey: "company_id", as: "employees" });

// Bus relationships
Bus.belongsTo(Company, { foreignKey: "company_id" });
Bus.belongsTo(User, { foreignKey: "driver_id", as: "driver" });
Bus.hasMany(DriverAssignment, { foreignKey: "bus_id" });
Bus.hasMany(Journal, { foreignKey: "bus_id" });
Bus.hasMany(Schedule, { foreignKey: "bus_id" });
Bus.hasMany(Location, { foreignKey: "bus_id" });
Bus.hasMany(Seat, { foreignKey: "bus_id" });

// Driver relationships
Driver.belongsTo(Company, { foreignKey: "company_id" });
Driver.belongsTo(User, { foreignKey: "user_id" });
Driver.hasMany(Bus, { foreignKey: "driver_id", as: "buses" });
Driver.hasMany(DriverAssignment, { foreignKey: "driver_id" });
Driver.hasMany(Journal, { foreignKey: "driver_id" });
Driver.hasMany(Schedule, { foreignKey: "driver_id" });
Driver.hasMany(Location, { foreignKey: "driver_id" });

// DriverAssignment relationships
DriverAssignment.belongsTo(Bus, { foreignKey: "bus_id" });
DriverAssignment.belongsTo(Driver, { foreignKey: "driver_id" });
DriverAssignment.belongsTo(Company, { foreignKey: "company_id" });
DriverAssignment.belongsTo(User, { foreignKey: "assigned_by" });

// Route relationships
Route.belongsTo(Company, { foreignKey: "company_id" });
Route.hasMany(Schedule, { foreignKey: "route_id" });

// Schedule relationships
Schedule.belongsTo(Bus, { foreignKey: "bus_id" });
Schedule.belongsTo(Route, { foreignKey: "route_id" });
Schedule.belongsTo(User, { foreignKey: "driver_id", as: 'driver' });
Schedule.belongsTo(Company, { foreignKey: "company_id" });
Schedule.belongsTo(User, { foreignKey: "created_by" });
Schedule.hasMany(Journal, { foreignKey: "schedule_id" });
Schedule.hasMany(Ticket, { foreignKey: "schedule_id" });
Schedule.hasMany(Location, { foreignKey: "schedule_id" });
Schedule.hasMany(ScheduleJournal, { foreignKey: 'schedule_id', as: 'journals' });
Schedule.hasMany(SeatLock, { foreignKey: 'schedule_id' });

// Payment relationships
Payment.belongsTo(User, { foreignKey: "user_id" });
Payment.belongsTo(Schedule, { foreignKey: "schedule_id" });
Payment.hasMany(Ticket, { foreignKey: "payment_id" });

// Ticket relationships
Ticket.belongsTo(User, { foreignKey: "passenger_id", as: "passenger" });
Ticket.belongsTo(Schedule, { foreignKey: "schedule_id" });
Ticket.belongsTo(Company, { foreignKey: "company_id" });
Ticket.belongsTo(Payment, { foreignKey: "payment_id" });
Ticket.belongsTo(SeatLock, { foreignKey: 'lock_id', as: 'lock' });

// Journal relationships
Journal.belongsTo(Bus, { foreignKey: "bus_id" });
Journal.belongsTo(User, { foreignKey: "driver_id", as: 'driver' });
Journal.belongsTo(Schedule, { foreignKey: "schedule_id" });
Journal.belongsTo(Company, { foreignKey: "company_id" });

// Location relationships
Location.belongsTo(Bus, { foreignKey: "bus_id" });
Location.belongsTo(User, { foreignKey: "driver_id", as: 'driver' });
Location.belongsTo(Schedule, { foreignKey: "schedule_id" });

// DriverLocation relationships (latest GPS for a driver)
DriverLocation.belongsTo(User, { foreignKey: 'driver_id', as: 'driver' });
User.hasOne(DriverLocation, { foreignKey: 'driver_id', as: 'driverLocation' });

// Notification relationships
Notification.belongsTo(User, { foreignKey: "user_id", as: "user" });

module.exports = {
  sequelize,
  User,
  Notification,
  Company,
  Bus,
  Driver,
  DriverAssignment,
  Journal,
  Route,
  Schedule,
  Ticket,
  Location,
  Payment,
  Seat,
  SeatLock,
  ScheduleJournal,
  LiveBusLocation
  ,DriverLocation
}