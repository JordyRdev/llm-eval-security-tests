# Synthetic data

Everything in this folder is made up for testing. It is not part of Chinook.

| File                 | Used in                                    | Purpose                                                                 |
| -------------------- | ------------------------------------------ | ----------------------------------------------------------------------- |
| `customer_notes.csv` | every role database (filtered by customer) | Free-text notes that end up in SQL results; later phases add payloads. |
| `employee_comp.csv`  | only the vulnerable database               | Confidential salaries that no role may ever see.                       |

`CustomerId` and `EmployeeId` refer to the fictitious Chinook customers and employees.
