// A fictional owner so tests are deterministic and carry no real person's data.
import { setOwnerForTests } from '../src/owner.js';

setOwnerForTests({
  name: 'Alex',
  timeZone: 'America/Chicago',
  school: {
    name: 'Example High School',
    place: 'Springfield',
    gradYear: 2027,
    staffDomains: ['district.example.edu'],
    studentDomain: 'students.district.example.edu',
    paymentHost: 'district.schoolpay.example',
  },
  familyNames: ['Doe'],
});
