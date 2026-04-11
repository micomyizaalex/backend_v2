const { Sequelize } = require('sequelize');

const User = require('./User')
const Notification = require("./Notification")
const sequelize = require("../config/database");
const Company = require("./Company");
const Bus = require("./Bus");
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
User.hasMany(DriverAssignment, { foreignKey: "assigned_by", as: "assignmentsMade" });
User.hasMany(DriverAssignment, { foreignKey: "driver_id", as: "driverAssignments" });
User.hasMany(Schedule, { foreignKey: "created_by", as: "schedulesCreated" });
User.hasMany(Ticket, { foreignKey: "passenger_id", as: "tickets" });
User.hasMany(Notification, { foreignKey: "user_id", as: "notifications" });
User.hasMany(Journal, { foreignKey: "driver_id", as: "driverJournals" });
User.hasMany(Location, { foreignKey: "driver_id", as: "driverLocations" });
User.hasMany(ScheduleJournal, { foreignKey: "performed_by", as: "scheduleChanges" });
User.belongsTo(Company, { foreignKey: "company_id", as: "company" });
User.hasOne(DriverLocation, { foreignKey: 'driver_id', as: 'driverLocation' });

// Company relationships
Company.belongsTo(User, { foreignKey: "owner_id", as: "owner" });
Company.belongsTo(User, { foreignKey: "approved_by", as: "approver" });
Company.hasMany(Bus, { foreignKey: "company_id", as: "buses" });
Company.hasMany(DriverAssignment, { foreignKey: "company_id", as: "driverAssignments" });
Company.hasMany(Journal, { foreignKey: "company_id", as: "journals" });
Company.hasMany(Route, { foreignKey: "company_id", as: "routes" });
Company.hasMany(Schedule, { foreignKey: "company_id", as: "schedules" });
Company.hasMany(Ticket, { foreignKey: "company_id", as: "tickets" });
Company.hasMany(User, { foreignKey: "company_id", as: "employees" });
Company.hasMany(ScheduleJournal, { foreignKey: "company_id", as: "scheduleJournals" });

// Bus relationships
Bus.belongsTo(Company, { foreignKey: "company_id", as: "company" });
Bus.hasMany(DriverAssignment, { foreignKey: "bus_id", as: "assignments" });
Bus.hasMany(Journal, { foreignKey: "bus_id", as: "journals" });
Bus.hasMany(Schedule, { foreignKey: "bus_id", as: "schedules" });
Bus.hasMany(Location, { foreignKey: "bus_id", as: "locations" });
Bus.hasMany(Seat, { foreignKey: "bus_id", as: "seats" });

// DriverAssignment relationships
DriverAssignment.belongsTo(Bus, { foreignKey: "bus_id", as: "bus" });
DriverAssignment.belongsTo(User, { foreignKey: "driver_id", as: "driver" });
DriverAssignment.belongsTo(Company, { foreignKey: "company_id", as: "company" });
DriverAssignment.belongsTo(User, { foreignKey: "assigned_by", as: "assigner" });

// Route relationships
Route.belongsTo(Company, { foreignKey: "company_id", as: "company" });
Route.hasMany(Schedule, { foreignKey: "route_id", as: "schedules" });

// Schedule relationships
Schedule.belongsTo(Bus, { foreignKey: "bus_id", as: "bus" });
Schedule.belongsTo(Route, { foreignKey: "route_id", as: "route" });
Schedule.belongsTo(Company, { foreignKey: "company_id", as: "company" });
Schedule.belongsTo(User, { foreignKey: "created_by", as: "creator" });
Schedule.hasMany(Journal, { foreignKey: "schedule_id", as: "tripJournals" });  // Changed alias
Schedule.hasMany(Ticket, { foreignKey: "schedule_id", as: "tickets" });
Schedule.hasMany(Location, { foreignKey: "schedule_id", as: "locations" });
Schedule.hasMany(ScheduleJournal, { foreignKey: 'schedule_id', as: 'auditJournals' });  // Changed alias
Schedule.hasMany(SeatLock, { foreignKey: 'schedule_id', as: "seatLocks" });

// Payment relationships
Payment.belongsTo(User, { foreignKey: "user_id", as: "user" });
Payment.belongsTo(Schedule, { foreignKey: "schedule_id", as: "schedule" });
Payment.hasMany(Ticket, { foreignKey: "payment_id", as: "tickets" });

// Ticket relationships
Ticket.belongsTo(User, { foreignKey: "passenger_id", as: "passenger" });
Ticket.belongsTo(Schedule, { foreignKey: "schedule_id", as: "schedule" });
Ticket.belongsTo(Company, { foreignKey: "company_id", as: "company" });
Ticket.belongsTo(Payment, { foreignKey: "payment_id", as: "payment" });
Ticket.belongsTo(SeatLock, { foreignKey: 'lock_id', as: 'lock' });

// Journal relationships
Journal.belongsTo(Bus, { foreignKey: "bus_id", as: "bus" });
Journal.belongsTo(User, { foreignKey: "driver_id", as: 'driver' });
Journal.belongsTo(Schedule, { foreignKey: "schedule_id", as: "schedule" });
Journal.belongsTo(Company, { foreignKey: "company_id", as: "company" });

// Location relationships
Location.belongsTo(Bus, { foreignKey: "bus_id", as: "bus" });
Location.belongsTo(User, { foreignKey: "driver_id", as: 'driver' });
Location.belongsTo(Schedule, { foreignKey: "schedule_id", as: "schedule" });

// DriverLocation relationships (latest GPS for a driver)
DriverLocation.belongsTo(User, { foreignKey: 'driver_id', as: 'driver' });

// Notification relationships
Notification.belongsTo(User, { foreignKey: "user_id", as: "user" });

// ScheduleJournal relationships
ScheduleJournal.belongsTo(Company, { foreignKey: "company_id", as: "company" });
ScheduleJournal.belongsTo(Schedule, { foreignKey: "schedule_id", as: "schedule" });
ScheduleJournal.belongsTo(User, { foreignKey: "performed_by", as: "performer" });

// Seat relationships
Seat.belongsTo(Bus, { foreignKey: "bus_id", as: "bus" });
Seat.hasMany(SeatLock, { foreignKey: "seat_id", as: "locks" });

// SeatLock relationships
SeatLock.belongsTo(Seat, { foreignKey: "seat_id", as: "seat" });
SeatLock.belongsTo(Schedule, { foreignKey: "schedule_id", as: "schedule" });
SeatLock.belongsTo(User, { foreignKey: "user_id", as: "user" });
SeatLock.hasOne(Ticket, { foreignKey: "lock_id", as: "ticket" });

// LiveBusLocation relationships
LiveBusLocation.belongsTo(Bus, { foreignKey: "bus_id", as: "bus" });
LiveBusLocation.belongsTo(Schedule, { foreignKey: "schedule_id", as: "schedule" });

module.exports = {
  sequelize,
  User,
  Notification,
  Company,
  Bus,
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
  LiveBusLocation,
  DriverLocation
}