const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Location = sequelize.define(
  "Location",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    company_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'companies',
        key: 'id'
      }
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
      allowNull: true,
      references: {
        model: 'users',
        key: 'id'
      }
    },

    schedule_id: {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: 'schedules',
        key: 'id'
      }
    },

    latitude: {
      type: DataTypes.DECIMAL(10, 8),
      allowNull: false,
    },

    longitude: {
      type: DataTypes.DECIMAL(11, 8),
      allowNull: false,
    },

    speed: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
      comment: 'Speed in km/h'
    },

    heading: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
      comment: 'Direction in degrees (0-360)'
    },

    accuracy: {
      type: DataTypes.DECIMAL(6, 2),
      allowNull: true,
      comment: 'GPS accuracy in meters'
    },

    location_timestamp: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      comment: 'When the GPS location was recorded'
    },
  },
  {
    tableName: "locations",
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ["company_id"] },
      { fields: ["bus_id"] },
      { fields: ["driver_id"] },
      { fields: ["schedule_id"] },
      { fields: ["location_timestamp"] },
      { fields: ["bus_id", "location_timestamp"] }, // For querying bus history
      { fields: ["schedule_id", "location_timestamp"] } // For querying trip history
    ],
  }
);

module.exports = Location;