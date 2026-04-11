// models/DriverAssignment.js
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const DriverAssignment = sequelize.define(
  "DriverAssignment",
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

    driver_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'users',  // References User (with role='driver')
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

    assigned_by: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'users',  // References User (company_admin or admin)
        key: 'id'
      }
    },

    assigned_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },

    unassigned_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    reason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    notes: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  },
  {
    tableName: "driver_assignments",
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['bus_id'] },
      { fields: ['driver_id'] },
      { fields: ['company_id'] },
      { fields: ['assigned_by'] },
      { fields: ['assigned_at'] }
    ]
  }
);

module.exports = DriverAssignment;