const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Schedule = sequelize.define(
  "Schedule",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    bus_id: { 
      type: DataTypes.UUID, 
      allowNull: false,
      references: {
        model: 'buses',
        key: 'id'
      }
    },
    
    route_id: { 
      type: DataTypes.UUID, 
      allowNull: false,
      references: {
        model: 'routes',
        key: 'id'
      }
    },
    
    company_id: { 
      type: DataTypes.UUID, 
      allowNull: false,
      references: {
        model: 'companies',
        key: 'id'
      }
    },

    schedule_date: { 
      type: DataTypes.DATEONLY, 
      allowNull: false 
    },
    
    departure_time: { 
      type: DataTypes.TIME, 
      allowNull: false 
    },
    
    arrival_time: { 
      type: DataTypes.TIME, 
      allowNull: false 
    },
    
    price_per_seat: { 
      type: DataTypes.DECIMAL, 
      allowNull: false 
    },
    
    total_seats: { 
      type: DataTypes.INTEGER, 
      allowNull: false, 
      defaultValue: 30 
    },
    
    available_seats: { 
      type: DataTypes.INTEGER, 
      allowNull: false 
    },
    
    booked_seats: { 
      type: DataTypes.INTEGER, 
      defaultValue: 0 
    },

    status: {
      type: DataTypes.ENUM("scheduled", "in_progress", "completed", "cancelled"),
      defaultValue: "scheduled",
    },

    ticket_status: {
      type: DataTypes.ENUM('OPEN', 'CLOSED'),
      allowNull: false,
      defaultValue: 'OPEN',
    },

    created_by: { 
      type: DataTypes.UUID, 
      allowNull: false,
      references: {
        model: 'users',
        key: 'id'
      }
    },
  },
  {
    tableName: "schedules",
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['bus_id'] },
      { fields: ['route_id'] },
      { fields: ['company_id'] },
      { fields: ['schedule_date'] },
      { fields: ['status'] },
      { fields: ['ticket_status'] }
    ]
  }
);

module.exports = Schedule;