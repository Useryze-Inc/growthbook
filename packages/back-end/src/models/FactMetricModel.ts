import { omit } from "lodash";
import { DEFAULT_PROPER_PRIOR_STDDEV } from "shared/constants";
import {
  getAggregateFilters,
  getSelectedColumnDatatype,
} from "shared/experiments";
import {
  ColumnRef,
  FactMetricInterface,
  FactMetricType,
  FactTableInterface,
  LegacyFactMetricInterface,
} from "back-end/types/fact-table";
import { ApiFactMetric } from "back-end/types/openapi";
import { factMetricValidator } from "back-end/src/routers/fact-table/fact-table.validators";
import { DEFAULT_CONVERSION_WINDOW_HOURS } from "back-end/src/util/secrets";
import { UpdateProps } from "back-end/types/models";
import { MakeModelClass } from "./BaseModel";
import { getFactTableMap } from "./FactTableModel";

const BaseClass = MakeModelClass({
  schema: factMetricValidator,
  collectionName: "factmetrics",
  idPrefix: "fact__",
  auditLog: {
    entity: "metric",
    createEvent: "metric.create",
    updateEvent: "metric.update",
    deleteEvent: "metric.delete",
  },
  globallyUniqueIds: false,
  readonlyFields: ["datasource"],
});

// extra checks on user filter
function validateUserFilter({
  metricType,
  numerator,
  factTable,
}: {
  metricType: FactMetricType;
  numerator: ColumnRef;
  factTable: FactTableInterface;
}): void {
  // error if one is specified but not the other
  if (!!numerator.aggregateFilter !== !!numerator.aggregateFilterColumn) {
    throw new Error(
      `Must specify both "aggregateFilter" and "aggregateFilterColumn" or neither.`
    );
  }

  // error if metric type is not retention or proportion
  if (metricType !== "retention" && metricType !== "proportion") {
    throw new Error(
      `Aggregate filter is only supported for retention and proportion metrics.`
    );
  }

  if (numerator.aggregateFilterColumn) {
    // error if column is not numeric or $$count
    const columnType = getSelectedColumnDatatype({
      factTable,
      column: numerator.aggregateFilterColumn,
    });
    if (
      !(
        columnType === "number" || numerator.aggregateFilterColumn === "$$count"
      )
    ) {
      throw new Error(
        `Aggregate filter column '${numerator.aggregateFilterColumn}' must be a numeric column or "$$count".`
      );
    }

    // error if filter is not valid
    getAggregateFilters({
      columnRef: numerator,
      column: numerator.aggregateFilterColumn,
      ignoreInvalid: false,
    });
  }
}

export class FactMetricModel extends BaseClass {
  protected canRead(doc: FactMetricInterface): boolean {
    return this.context.hasPermission("readData", doc.projects || []);
  }
  protected canCreate(doc: FactMetricInterface): boolean {
    return this.context.permissions.canCreateFactMetric(doc);
  }
  protected canUpdate(
    existing: FactMetricInterface,
    updates: UpdateProps<FactMetricInterface>
  ): boolean {
    return this.context.permissions.canUpdateFactMetric(existing, updates);
  }
  protected canDelete(doc: FactMetricInterface): boolean {
    return this.context.permissions.canDeleteFactMetric(doc);
  }

  public static upgradeFactMetricDoc(
    doc: LegacyFactMetricInterface
  ): FactMetricInterface {
    const newDoc = { ...doc };

    if (doc.windowSettings === undefined) {
      newDoc.windowSettings = {
        type: doc.hasConversionWindow ? "conversion" : "",
        windowValue:
          doc.conversionWindowValue || DEFAULT_CONVERSION_WINDOW_HOURS,
        windowUnit: doc.conversionWindowUnit || "hours",
        delayValue: doc.conversionDelayHours || 0,
        delayUnit: "hours",
      };
    } else if (doc.windowSettings.delayValue === undefined) {
      newDoc.windowSettings = {
        ...doc.windowSettings,
        delayValue: doc.windowSettings.delayHours ?? 0,
        delayUnit: doc.windowSettings.delayUnit ?? "hours",
      };
      delete newDoc.windowSettings.delayHours;
    }

    if (doc.cappingSettings === undefined) {
      newDoc.cappingSettings = {
        type: doc.capping || "",
        value: doc.capValue || 0,
      };
    }

    if (doc.priorSettings === undefined) {
      newDoc.priorSettings = {
        override: false,
        proper: false,
        mean: 0,
        stddev: DEFAULT_PROPER_PRIOR_STDDEV,
      };
    }

    return newDoc as FactMetricInterface;
  }

  protected migrate(legacyDoc: unknown): FactMetricInterface {
    return FactMetricModel.upgradeFactMetricDoc(
      legacyDoc as LegacyFactMetricInterface
    );
  }

  protected async beforeCreate(doc: FactMetricInterface) {
    if (!doc.id.match(/^fact__[-a-zA-Z0-9_]+$/)) {
      throw new Error(
        "Fact metric ids MUST start with 'fact__' and contain only letters, numbers, underscores, and dashes"
      );
    }
  }

  protected async beforeUpdate(existing: FactMetricInterface) {
    if (existing.managedBy === "api" && !this.context.isApiRequest) {
      throw new Error("Cannot update fact metric managed by API");
    }
  }

  protected async beforeDelete(existing: FactMetricInterface) {
    if (existing.managedBy === "api" && !this.context.isApiRequest) {
      throw new Error("Cannot delete fact metric managed by API");
    }
  }

  // TODO: Once we migrate fact tables to new data model, we can use that instead
  private _factTableMap: Map<string, FactTableInterface> | null = null;
  private async getFactTableMap() {
    if (!this._factTableMap) {
      this._factTableMap = await getFactTableMap(this.context);
    }
    return this._factTableMap;
  }

  protected async customValidation(data: FactMetricInterface): Promise<void> {
    const factTableMap = await this.getFactTableMap();

    const numeratorFactTable = factTableMap.get(data.numerator.factTableId);
    if (!numeratorFactTable) {
      throw new Error("Could not find numerator fact table");
    }

    if (data.numerator.filters?.length) {
      for (const filter of data.numerator.filters) {
        if (!numeratorFactTable.filters.some((f) => f.id === filter)) {
          throw new Error(`Invalid numerator filter id: ${filter}`);
        }
      }
    }

    // validate user filter
    if (
      data.numerator.aggregateFilterColumn ||
      data.numerator.aggregateFilter
    ) {
      validateUserFilter({
        metricType: data.metricType,
        numerator: data.numerator,
        factTable: numeratorFactTable,
      });
    }

    if (data.metricType === "ratio") {
      if (!data.denominator) {
        throw new Error("Denominator required for ratio metric");
      }
      if (data.denominator.factTableId !== data.numerator.factTableId) {
        const denominatorFactTable = factTableMap.get(
          data.denominator.factTableId
        );
        if (!denominatorFactTable) {
          throw new Error("Could not find denominator fact table");
        }
        if (denominatorFactTable.datasource !== numeratorFactTable.datasource) {
          throw new Error(
            "Numerator and denominator must be in the same datasource"
          );
        }

        if (data.denominator.filters?.length) {
          for (const filter of data.denominator.filters) {
            if (!denominatorFactTable.filters.some((f) => f.id === filter)) {
              throw new Error(`Invalid denominator filter id: ${filter}`);
            }
          }
        }
      }
    } else if (data.denominator?.factTableId) {
      throw new Error("Denominator not allowed for non-ratio metric");
    }
    if (data.metricType === "quantile") {
      if (!this.context.hasPremiumFeature("quantile-metrics")) {
        throw new Error("Quantile metrics are a premium feature");
      }

      if (!data.quantileSettings) {
        throw new Error("Must specify `quantileSettings` for quantile metrics");
      }
    }
    if (
      data.metricType === "retention" &&
      !this.context.hasPremiumFeature("retention-metrics")
    ) {
      throw new Error("Retention metrics are a premium feature");
    }
    if (data.loseRisk < data.winRisk) {
      throw new Error(
        `riskThresholdDanger (${data.loseRisk}) must be greater than riskThresholdSuccess (${data.winRisk})`
      );
    }

    if (data.minPercentChange >= data.maxPercentChange) {
      throw new Error(
        `maxPercentChange (${data.maxPercentChange}) must be greater than minPercentChange (${data.minPercentChange})`
      );
    }
  }

  public toApiInterface(factMetric: FactMetricInterface): ApiFactMetric {
    const {
      quantileSettings,
      cappingSettings,
      windowSettings,
      regressionAdjustmentDays,
      regressionAdjustmentEnabled,
      regressionAdjustmentOverride,
      dateCreated,
      dateUpdated,
      denominator,
      metricType,
      loseRisk,
      winRisk,
      ...otherFields
    } = omit(factMetric, ["organization"]);

    return {
      ...otherFields,
      riskThresholdDanger: loseRisk,
      riskThresholdSuccess: winRisk,
      metricType: metricType,
      quantileSettings: quantileSettings || undefined,
      cappingSettings: {
        ...cappingSettings,
        type: cappingSettings.type || "none",
      },
      windowSettings: {
        ...windowSettings,
        type: windowSettings.type || "none",
      },
      managedBy: factMetric.managedBy || "",
      denominator: denominator || undefined,
      regressionAdjustmentSettings: {
        override: regressionAdjustmentOverride || false,
        ...(regressionAdjustmentOverride
          ? {
              enabled: regressionAdjustmentEnabled || false,
            }
          : null),
        ...(regressionAdjustmentOverride && regressionAdjustmentEnabled
          ? {
              days: regressionAdjustmentDays || 0,
            }
          : null),
      },
      dateCreated: dateCreated?.toISOString() || "",
      dateUpdated: dateUpdated?.toISOString() || "",
    };
  }
}
